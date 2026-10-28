package dev.ompconsole.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class DaemonUrlTest {
    @Test
    public void httpsAnyHostDefaultPortsDropped() {
        assertEquals("https://box.tailnet-example.ts.net", DaemonUrl.originOf("https://box.tailnet-example.ts.net/deck?x=1"));
        assertEquals("https://box.ts.net", DaemonUrl.originOf("https://BOX.ts.net:443/"));
        assertEquals("https://box.ts.net:8443", DaemonUrl.originOf("https://box.ts.net:8443"));
    }

    @Test
    public void plainHttpOnlyForLocalAndPrivateHosts() {
        assertEquals("http://10.0.2.2:8080", DaemonUrl.originOf("http://10.0.2.2:8080/"));
        assertEquals("http://localhost", DaemonUrl.originOf("http://localhost:80"));
        assertNull(DaemonUrl.originOf("http://172.32.0.1"));
        assertNull(DaemonUrl.originOf("http://box.ts.net"));
        assertNull(DaemonUrl.originOf("http://192.168.1.256"));
    }

    @Test
    public void rejectsCredentialsOtherSchemesAndGarbage() {
        assertNull(DaemonUrl.originOf("https://user:pw@box.ts.net"));
        assertNull(DaemonUrl.originOf("ftp://box.ts.net"));
        assertNull(DaemonUrl.originOf("javascript:alert(1)"));
        assertNull(DaemonUrl.originOf(null));
        assertNull(DaemonUrl.originOf("not a url"));
    }
}
