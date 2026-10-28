package dev.ompconsole.mobile;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Validation of the stored daemon URL. Mirrors www/url.js: the launcher validates for UX, this class
 * re-validates before the native bridge trusts an origin. Keep both in sync.
 */
final class DaemonUrl {
    /** Capacitor Preferences plugin storage group and the launcher's key. */
    static final String PREFS_GROUP = "CapacitorStorage";
    static final String PREFS_KEY = "daemonUrl";

    private static final Pattern IPV4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");

    private DaemonUrl() {}

    /** Origin (`scheme://host[:port]`, default ports dropped) of an acceptable URL, else null. */
    static String originOf(String url) {
        if (url == null) return null;
        URI uri;
        try {
            uri = new URI(url.trim());
        } catch (Exception e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isEmpty() || uri.getUserInfo() != null) return null;
        host = host.toLowerCase(Locale.ROOT);
        boolean https = scheme.equals("https");
        if (!https && !(scheme.equals("http") && isPlainHttpHost(host))) return null;
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (https && port == 443) || (!https && port == 80);
        return scheme + "://" + host + (defaultPort ? "" : ":" + port);
    }

    static boolean isPlainHttpHost(String host) {
        if (host.equals("localhost") || host.endsWith(".localhost") || host.equals("[::1]")) return true;
        Matcher m = IPV4.matcher(host);
        if (!m.matches()) return false;
        int[] o = new int[4];
        for (int i = 0; i < 4; i++) {
            o[i] = Integer.parseInt(m.group(i + 1));
            if (o[i] > 255) return false;
        }
        int a = o[0];
        int b = o[1];
        return a == 127 || a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
    }
}
