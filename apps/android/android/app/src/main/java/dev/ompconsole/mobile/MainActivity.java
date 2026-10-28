package dev.ompconsole.mobile;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.capacitorjs.plugins.localnotifications.LocalNotificationManager;

public class MainActivity extends BridgeActivity {
    /** Fired by the launcher's static shortcut "Change daemon URL". */
    static final String ACTION_CHANGE_URL = "dev.ompconsole.mobile.CHANGE_URL";
    private static final long CORNER_LONG_PRESS_MS = 1000;
    private static final int CORNER_DP = 64;

    private DeckWebViewClient client;
    private DeckBridge deck;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable openSettings = this::openUrlSettings;
    private float downX;
    private float downY;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge == null) return; // no WebView provider installed; Capacitor shows its own notice
        SharedPreferences prefs = getSharedPreferences(DaemonUrl.PREFS_GROUP, MODE_PRIVATE);
        deck = new DeckBridge(bridge);
        client = new DeckWebViewClient(bridge, deck, prefs);
        bridge.setWebViewClient(client);
        String stored = client.storedOrigin();
        if (stored != null) deck.trust(stored);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge.getWebView();
                // History first; the launcher and retry screens are not history, back leaves the app.
                if (webView.canGoBack() && !client.isLocalPage(webView.getUrl())) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });

        installCornerLongPress(bridge.getWebView());
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (client != null) handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent != null && ACTION_CHANGE_URL.equals(intent.getAction())) {
            openUrlSettings();
            return;
        }
        if (deck != null && intent != null && deck.handleNotificationAction(intent)) {
            intent.removeExtra(LocalNotificationManager.ACTION_INTENT_KEY);
            intent.removeExtra(LocalNotificationManager.NOTIFICATION_OBJ_INTENT_KEY);
            intent.removeExtra(LocalNotificationManager.NOTIFICATION_INTENT_KEY);
        }
    }

    private void openUrlSettings() {
        String base = bridge.getAppUrl();
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        bridge.getWebView().loadUrl(base + "/index.html?edit=1");
    }

    /** One-second press in the top-left corner opens the URL screen. Touches still reach the page. */
    private void installCornerLongPress(WebView webView) {
        float density = getResources().getDisplayMetrics().density;
        float corner = CORNER_DP * density;
        float slop = ViewConfiguration.get(this).getScaledTouchSlop();
        webView.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getX();
                    downY = event.getY();
                    if (downX <= corner && downY <= corner) handler.postDelayed(openSettings, CORNER_LONG_PRESS_MS);
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (Math.abs(event.getX() - downX) > slop || Math.abs(event.getY() - downY) > slop) {
                        handler.removeCallbacks(openSettings);
                    }
                    break;
                case MotionEvent.ACTION_POINTER_DOWN:
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    handler.removeCallbacks(openSettings);
                    break;
                default:
                    break;
            }
            return false;
        });
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(openSettings);
        super.onDestroy();
    }
}
