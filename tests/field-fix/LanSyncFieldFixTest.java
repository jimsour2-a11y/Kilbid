package ee.dold.techcontrol;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Regression tests for the v0.5.6.1 native side of the field handshake fix. */
public final class LanSyncFieldFixTest {
    private static int passed;
    private static int failed;

    private interface Case { void run() throws Exception; }

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }

    private static void test(String name, Case body) {
        try { body.run(); passed++; System.out.println("PASS " + name); }
        catch (Throwable error) { failed++; System.err.println("FAIL " + name + ": " + error); }
    }

    private static LanSyncTransport transport() {
        return new LanSyncTransport(InetAddress::getLoopbackAddress);
    }

    private static LanSyncTransport.HostStatus awaitHost(LanSyncTransport host, String state) throws Exception {
        long deadline = System.currentTimeMillis() + 5000L;
        do {
            LanSyncTransport.HostStatus status = host.getHostStatus();
            if (state.equals(status.status)) return status;
            Thread.sleep(2L);
        } while (System.currentTimeMillis() < deadline);
        throw new AssertionError("wanted " + state + ", got " + host.getHostStatus().status);
    }

    private static LanSyncTransport.ClientResult awaitClient(LanSyncTransport client, LanSyncTransport.ClientJob job) throws Exception {
        long deadline = System.currentTimeMillis() + 5000L;
        do {
            LanSyncTransport.ClientResult result = client.getClientJob(job.id).getResult();
            if (result != null) return result;
            Thread.sleep(2L);
        } while (System.currentTimeMillis() < deadline);
        throw new AssertionError("client exchange timed out");
    }

    private static LanSyncTransport.StartResult start(LanSyncTransport host, String dbId) {
        return host.startHostDeferredForTest(dbId, bytes("baseline"), 15000L);
    }

    public static void main(String[] args) {
        test("one REQUEST_RECEIVED is consumed by one queued response", () -> {
            try (LanSyncTransport host = transport(); LanSyncTransport client = transport()) {
                LanSyncTransport.StartResult start = start(host, "field-fix-one");
                LanSyncTransport.ClientJob job = client.startClient(start.pairing, "field-fix-one", bytes("client-delta"));
                check("REQUEST_RECEIVED".equals(awaitHost(host, "REQUEST_RECEIVED").status), "request event missing");
                check(host.respondHost(bytes("host-delta"), false), "host response rejected");
                check("RESPONSE_QUEUED".equals(host.getHostStatus().status), "request event was not consumed synchronously");
                check(!host.respondHost(bytes("duplicate"), false), "duplicate response was accepted");
                LanSyncTransport.ClientResult result = awaitClient(client, job);
                check(result.isSuccess() && Arrays.equals(result.payload, bytes("host-delta")), "first exchange response changed");
                check("WAITING_ACK".equals(awaitHost(host, "WAITING_ACK").status), "host did not advance to second exchange");
                host.stopHostForSession(start.pairing.sessionId);
                awaitHost(host, "CANCELLED");
            }
        });

        test("second connection receives ACK_RECEIVED and client gets SYNC_COMMITTED", () -> {
            try (LanSyncTransport host = transport(); LanSyncTransport client = transport()) {
                LanSyncTransport.StartResult start = start(host, "field-fix-two");
                LanSyncTransport.ClientJob first = client.startClient(start.pairing, "field-fix-two", bytes("initial-delta"));
                awaitHost(host, "REQUEST_RECEIVED");
                check(host.respondHost(bytes("host-delta"), false), "first response rejected");
                check(awaitClient(client, first).isSuccess(), "first exchange failed");
                awaitHost(host, "WAITING_ACK");

                byte[] committed = bytes("SYNC_COMMITTED");
                LanSyncTransport.ClientJob second = client.startClient(start.pairing, "field-fix-two", bytes("post-commit-delta"));
                LanSyncTransport.HostStatus ackEvent = awaitHost(host, "ACK_RECEIVED");
                check(Arrays.equals(ackEvent.receivedPayload, bytes("post-commit-delta")), "second exchange payload changed");
                check(host.respondHost(committed, true), "terminal commit response rejected");
                check("RESPONSE_QUEUED".equals(host.getHostStatus().status), "ACK event was not consumed synchronously");
                check(!host.respondHost(bytes("duplicate-commit"), true), "duplicate commit response was accepted");
                LanSyncTransport.ClientResult finalResult = awaitClient(client, second);
                check(finalResult.isSuccess() && Arrays.equals(finalResult.payload, committed), "client did not receive SYNC_COMMITTED");
                check("COMPLETED".equals(awaitHost(host, "COMPLETED").status), "host did not reach COMPLETED");
            }
        });

        test("wrong session cleanup leaves a valid listener active", () -> {
            try (LanSyncTransport host = transport()) {
                LanSyncTransport.StartResult start = start(host, "field-fix-three");
                check(!host.stopHostForSession("not-the-active-session"), "wrong session ID stopped the host");
                check("SESSION_ACTIVE".equals(start(host, "field-fix-three").status), "valid session was hidden by another start");
                check(host.stopHostForSession(start.pairing.sessionId), "matching session cleanup failed");
                check("CANCELLED".equals(awaitHost(host, "CANCELLED").status), "matching cleanup did not terminate host");
            }
        });

        test("unconfirmed non-terminal session permits immediate fresh QR after cleanup", () -> {
            try (LanSyncTransport host = transport(); LanSyncTransport client = transport()) {
                LanSyncTransport.StartResult old = start(host, "field-fix-four");
                LanSyncTransport.ClientJob first = client.startClient(old.pairing, "field-fix-four", bytes("first-phase"));
                awaitHost(host, "REQUEST_RECEIVED");
                check(host.respondHost(bytes("proposal"), false), "proposal response rejected");
                check(awaitClient(client, first).isSuccess(), "proposal was not delivered");
                awaitHost(host, "WAITING_ACK");
                check("SESSION_ACTIVE".equals(start(host, "field-fix-four").status), "unconfirmed live session was silently replaced");

                check(host.stopHostForSession(old.pairing.sessionId), "error-flow session cleanup failed");
                check("CANCELLED".equals(awaitHost(host, "CANCELLED").status), "failed session did not close");
                LanSyncTransport.StartResult fresh = start(host, "field-fix-four");
                check("STARTED".equals(fresh.status), "new host could not start immediately");
                check(!old.pairing.sessionId.equals(fresh.pairing.sessionId), "session ID was reused");
                check(!old.pairing.token.equals(fresh.pairing.token), "one-time token was reused");
                host.stopHostForSession(fresh.pairing.sessionId);
            }
        });

        if (failed != 0) throw new AssertionError("v0.5.6.1 native tests: " + passed + "/" + (passed + failed));
        System.out.println("V0561_NATIVE " + passed + "/" + passed + " PASS");
    }
}
