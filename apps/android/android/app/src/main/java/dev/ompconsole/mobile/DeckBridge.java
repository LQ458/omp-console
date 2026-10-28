package dev.ompconsole.mobile;

import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin;
import com.capacitorjs.plugins.localnotifications.LocalNotificationManager;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Exposes the notification and answer-action bridge to the daemon web UI.
 *
 * The web UI runs on the daemon origin, where Capacitor does not inject its own JS bridge. So the
 * page gets a document-start shim plus an origin-scoped WebMessageListener; both are bound to
 * exactly one origin, the stored daemon URL's.
 */
final class DeckBridge {
    private static final String TAG = "OmpConsoleBridge";
    static final String JS_OBJECT = "OmpConsoleAndroidNative";
    private static final String SHIM_ASSET = "deck-android-shim.js";
    private static final int MAX_TITLE = 120;
    private static final int MAX_BODY = 400;
    private static final int MAX_TAG = 64;
    private static final int MAX_ACTIONS = 3;
    private static final int MAX_ACTION_TITLE = 64;
    private static final String ACTION_TYPE_ID = "omp-console-answer";
    private static final Pattern ANSWER_TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final String DEFAULT_ACTION = "tap";

    private static final class AnswerAction {
        final String title;
        final String value;
        final String token;
        final String url;

        AnswerAction(String title, String value, String token, String url) {
            this.title = title;
            this.value = value;
            this.token = token;
            this.url = url;
        }
    }


    private final Bridge bridge;
    private String origin;
    private ScriptHandler shim;

    DeckBridge(Bridge bridge) {
        this.bridge = bridge;
    }

    /** Bind the bridge to one origin; replaces any previous binding. Takes effect on the next navigation. */
    void trust(@NonNull String newOrigin) {
        if (newOrigin.equals(origin)) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(TAG, "WebView lacks WEB_MESSAGE_LISTENER or DOCUMENT_START_SCRIPT; omp console bridge disabled");
            return;
        }
        WebView webView = bridge.getWebView();
        release();
        Set<String> rules = Collections.singleton(newOrigin);
        WebViewCompat.addWebMessageListener(webView, JS_OBJECT, rules, this::onMessage);
        shim = WebViewCompat.addDocumentStartJavaScript(webView, readShim(), rules);
        origin = newOrigin;
        Log.i(TAG, "omp console bridge bound to " + newOrigin);
    }

    private void release() {
        if (origin == null) return;
        WebViewCompat.removeWebMessageListener(bridge.getWebView(), JS_OBJECT);
        if (shim != null) shim.remove();
        shim = null;
        origin = null;
    }

    private String readShim() {
        try (InputStream in = bridge.getContext().getAssets().open(SHIM_ASSET)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("missing asset " + SHIM_ASSET, e);
        }
    }

    private void onMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) {
        // The origin rules already filter, this keeps subframes and stale bindings out as well.
        if (!isMainFrame || origin == null || !origin.equals(DaemonUrl.originOf(sourceOrigin.toString()))) {
            Log.w(TAG, "ignored message from " + sourceOrigin);
            return;
        }
        String data = message.getData();
        if (data == null) return;
        try {
            JSONObject json = new JSONObject(data);
            if ("notify".equals(json.optString("type"))) {
                notify(
                    clamp(json.optString("title"), MAX_TITLE),
                    clamp(json.optString("body"), MAX_BODY),
                    clamp(json.optString("tag"), MAX_TAG),
                    readActions(json.optJSONArray("actions"))
                );
            }
        } catch (Exception e) {
            // The message may contain a one-use answer token; never log parser exceptions or payloads.
            Log.w(TAG, "bad bridge message");
        }
    }

    private List<AnswerAction> readActions(JSONArray values) {
        if (values == null || values.length() == 0 || values.length() > MAX_ACTIONS) return Collections.emptyList();
        List<AnswerAction> actions = new ArrayList<>(values.length());
        String sharedToken = null;
        String sharedUrl = null;
        for (int i = 0; i < values.length(); i++) {
            JSONObject value = values.optJSONObject(i);
            if (value == null) return Collections.emptyList();
            String title = clamp(value.optString("title"), MAX_ACTION_TITLE);
            String answer = value.optString("value");
            String token = value.optString("token");
            String url = value.optString("url");
            if (
                title.isEmpty() ||
                answer.isEmpty() ||
                !ANSWER_TOKEN.matcher(token).matches() ||
                origin == null ||
                !origin.equals(DaemonUrl.originOf(url))
            ) {
                return Collections.emptyList();
            }
            if (sharedToken != null && (!sharedToken.equals(token) || !sharedUrl.equals(url))) {
                return Collections.emptyList();
            }
            sharedToken = token;
            sharedUrl = url;
            actions.add(new AnswerAction(title, answer, token, url));
        }
        return actions;
    }

    /** Handles a local-notification tap or choice. Invalid or unavailable answers open the session instead. */
    boolean handleNotificationAction(Intent intent) {
        if (intent == null) return false;
        String action = intent.getStringExtra(LocalNotificationManager.ACTION_INTENT_KEY);
        String notificationJson = intent.getStringExtra(LocalNotificationManager.NOTIFICATION_OBJ_INTENT_KEY);
        if (action == null || notificationJson == null) return false;
        try {
            JSONObject notification = new JSONObject(notificationJson);
            JSONObject extra = notification.optJSONObject("extra");
            JSONObject answer = extra == null ? null : extra.optJSONObject("answer");
            if (answer == null) return false;
            String url = answer.optString("url");
            if (origin == null || !origin.equals(DaemonUrl.originOf(url))) return false;
            if (DEFAULT_ACTION.equals(action)) return loadSession(url);
            if (!action.startsWith("answer-")) return false;
            int index;
            try {
                index = Integer.parseInt(action.substring("answer-".length()));
            } catch (NumberFormatException e) {
                return loadSession(url);
            }
            JSONArray values = answer.optJSONArray("values");
            String token = answer.optString("token");
            if (values == null || index < 0 || index >= values.length() || !ANSWER_TOKEN.matcher(token).matches()) {
                return loadSession(url);
            }
            String value = values.optString(index);
            if (value.isEmpty()) return loadSession(url);
            String script =
                "(function(){var f=window.__ompConsoleAndroidAnswerAction;if(typeof f==='function'){f(" +
                JSONObject.quote(token) +
                "," +
                JSONObject.quote(value) +
                "," +
                JSONObject.quote(url) +
                ");return true;}return false;})()";
            bridge.getWebView().evaluateJavascript(script, result -> {
                if (!"true".equals(result)) loadSession(url);
            });
            return true;
        } catch (Exception e) {
            Log.w(TAG, "invalid notification action");
            return false;
        }
    }

    private boolean loadSession(String url) {
        if (origin == null || !origin.equals(DaemonUrl.originOf(url))) return false;
        bridge.getWebView().loadUrl(url);
        return true;
    }


    private static String clamp(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private void notify(String title, String body, String tag, List<AnswerAction> actions) {
        if (title.isEmpty() && body.isEmpty()) return;
        if (!NotificationManagerCompat.from(bridge.getContext()).areNotificationsEnabled()) {
            Log.i(TAG, "notifications disabled or permission not granted; dropped");
            return;
        }
        PluginHandle handle = bridge.getPlugin("LocalNotifications");
        Plugin plugin = handle == null ? null : handle.getInstance();
        if (!(plugin instanceof LocalNotificationsPlugin)) {
            Log.w(TAG, "LocalNotifications plugin not loaded");
            return;
        }
        // The same tag replaces the previous notification; untagged ones stack.
        int id = tag.isEmpty() ? (int) (System.nanoTime() & 0x7fffffff) : tag.hashCode() & 0x7fffffff;
        try {
            if (!actions.isEmpty()) registerAnswerActions((LocalNotificationsPlugin) plugin, actions);
            JSObject notification = new JSObject();
            notification.put("id", id);
            notification.put("title", title);
            notification.put("body", body);
            // Fire now. isExactNotification=false avoids the exact-alarm settings prompt.
            notification.put("isExactNotification", false);
            if (!actions.isEmpty()) {
                notification.put("actionTypeId", ACTION_TYPE_ID);
                JSArray values = new JSArray();
                for (AnswerAction action : actions) values.put(action.value);
                JSObject answer = new JSObject()
                    .put("token", actions.get(0).token)
                    .put("url", actions.get(0).url)
                    .put("values", values);
                notification.put("extra", new JSObject().put("tag", tag).put("answer", answer));
            } else {
                notification.put("extra", new JSObject().put("tag", tag));
            }
            JSObject data = new JSObject();
            data.put("notifications", new JSArray().put(notification));
            ((LocalNotificationsPlugin) plugin).schedule(new NativeCall("schedule", data));
        } catch (Exception e) {
            Log.w(TAG, "notify failed");
        }
    }

    private void registerAnswerActions(LocalNotificationsPlugin plugin, List<AnswerAction> actions) throws Exception {
        JSArray buttons = new JSArray();
        for (int i = 0; i < actions.size(); i++) {
            buttons.put(new JSObject().put("id", "answer-" + i).put("title", actions.get(i).title));
        }
        JSObject actionType = new JSObject().put("id", ACTION_TYPE_ID).put("actions", buttons);
        JSObject data = new JSObject().put("types", new JSArray().put(actionType));
        plugin.registerActionTypes(new NativeCall("registerActionTypes", data));
    }

    /** A PluginCall with no JS caller: results are logged instead of sent to a WebView. */
    private static final class NativeCall extends PluginCall {
        NativeCall(String methodName, JSObject data) {
            super(null, "LocalNotifications", PluginCall.CALLBACK_ID_DANGLING, methodName, data);
        }

        @Override
        public void resolve(JSObject data) {
            // Nothing waits for the result.
        }

        @Override
        public void resolve() {
            // Nothing waits for the result.
        }

        @Override
        public void reject(String msg, String code, Exception ex, JSObject data) {
            Log.w(TAG, "LocalNotifications rejected an internal bridge call");
        }

        @Override
        public void errorCallback(String msg) {
            Log.w(TAG, "LocalNotifications internal bridge call failed");
        }
    }
}
