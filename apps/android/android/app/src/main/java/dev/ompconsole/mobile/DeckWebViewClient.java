package dev.ompconsole.mobile;

import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Keeps the daemon page inside the WebView (Capacitor would hand any foreign origin to the system
 * browser) and replaces failed main-frame loads with the local retry screen, never a blank page.
 */
final class DeckWebViewClient extends BridgeWebViewClient {
    private final Bridge bridge;
    private final DeckBridge deck;
    private final SharedPreferences prefs;

    DeckWebViewClient(Bridge bridge, DeckBridge deck, SharedPreferences prefs) {
        super(bridge);
        this.bridge = bridge;
        this.deck = deck;
        this.prefs = prefs;
    }

    /** Origin of the daemon URL the launcher stored, or null if unset or not acceptable. */
    String storedOrigin() {
        return DaemonUrl.originOf(prefs.getString(DaemonUrl.PREFS_KEY, null));
    }

    boolean isLocalPage(String url) {
        return url != null && url.startsWith(localBase());
    }

    private String localBase() {
        String base = bridge.getAppUrl();
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String origin = DaemonUrl.originOf(request.getUrl().toString());
        if (origin != null && origin.equals(storedOrigin())) {
            // Bind the notification bridge before this navigation commits.
            deck.trust(origin);
            return false;
        }
        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame() || isLocalPage(request.getUrl().toString())) return;
        CharSequence description = error.getDescription();
        // A newer navigation superseding this one is not a failure.
        if (description != null && description.toString().contains("ERR_ABORTED")) return;
        showOffline(view, request.getUrl().toString(), description == null ? "Load failed" : description.toString());
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (!request.isForMainFrame() || isLocalPage(request.getUrl().toString())) return;
        int status = response.getStatusCode();
        // 5xx: daemon or tailscale serve down. 401/403: not allowed by the daemon's owner check.
        if (status >= 500 || status == 401 || status == 403) {
            showOffline(view, request.getUrl().toString(), "The server answered HTTP " + status + ".");
        }
    }

    private void showOffline(WebView view, String failedUrl, String reason) {
        view.loadUrl(localBase() + "/offline.html?url=" + Uri.encode(failedUrl) + "&reason=" + Uri.encode(reason));
    }
}
