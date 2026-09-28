package ee.dold.techcontrol;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** R4 native session handshake tests. Business merge remains in the WebView semantic engine. */
public final class LanSyncR4SessionTest {
    private static int passed;
    private static int failed;

    private static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }

    private static void test(String name, Runnable body) {
        try { body.run(); passed++; System.out.println("PASS " + name); }
        catch (Throwable t) { failed++; System.err.println("FAIL " + name + ": " + t); }
    }

    private static LanSyncTransport transport() throws Exception {
        return new LanSyncTransport(InetAddress::getLoopbackAddress);
    }

    private static LanSyncTransport.HostStatus awaitHost(LanSyncTransport transport, String state) throws Exception {
        long end = System.currentTimeMillis() + 5000L;
        LanSyncTransport.HostStatus status;
        do {
            status = transport.getHostStatus();
            if (state.equals(status.status)) return status;
            Thread.sleep(5L);
        } while (System.currentTimeMillis() < end);
        throw new AssertionError("host state timeout; wanted " + state + ", got " + transport.getHostStatus().status);
    }

    private static LanSyncTransport.ClientResult awaitClient(LanSyncTransport transport, LanSyncTransport.ClientJob job) throws Exception {
        long end = System.currentTimeMillis() + 5000L;
        while (System.currentTimeMillis() < end) {
            LanSyncTransport.ClientResult result = transport.getClientJob(job.id).getResult();
            if (result != null) return result;
            Thread.sleep(5L);
        }
        throw new AssertionError("client exchange timed out");
    }

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    public static void main(String[] args) throws Exception {
        test("R4 one QR session returns host delta then accepts committed peer delta", () -> {
            try (LanSyncTransport host = transport(); LanSyncTransport client = transport()) {
                byte[] ignoredInitial = bytes("initial-template");
                LanSyncTransport.StartResult started = host.startHostDeferredForTest("db-r4", ignoredInitial, 20_000L);
                check("STARTED".equals(started.status), "deferred host did not start");
                byte[] firstRequest = bytes("phone-b-semantic-delta");
                LanSyncTransport.ClientJob firstJob = client.startClient(started.pairing, "db-r4", firstRequest);
                LanSyncTransport.HostStatus proposal = awaitHost(host, "REQUEST_RECEIVED");
                check(Arrays.equals(firstRequest, proposal.receivedPayload), "proposal bytes changed in transport");
                byte[] hostDelta = bytes("phone-a-semantic-delta");
                check(host.respondHost(hostDelta, false), "host proposal response was not accepted");
                LanSyncTransport.ClientResult first = awaitClient(client, firstJob);
                check(first.isSuccess() && Arrays.equals(hostDelta, first.payload), "client did not receive host delta");
                awaitHost(host, "WAITING_ACK");

                byte[] finalPeerDelta = bytes("phone-b-post-merge-delta");
                LanSyncTransport.ClientJob secondJob = client.startClient(started.pairing, "db-r4", finalPeerDelta);
                LanSyncTransport.HostStatus finalProposal = awaitHost(host, "ACK_RECEIVED");
                check(Arrays.equals(finalPeerDelta, finalProposal.receivedPayload), "final peer delta changed in transport");
                byte[] commitAck = bytes("durable-commit-confirmed");
                check(host.respondHost(commitAck, true), "commit response was not accepted");
                LanSyncTransport.ClientResult second = awaitClient(client, secondJob);
                check(second.isSuccess() && Arrays.equals(commitAck, second.payload), "client did not receive durable acknowledgement");
                check("COMPLETED".equals(awaitHost(host, "COMPLETED").status), "session did not terminate after final acknowledgement");
            } catch (Exception e) { throw new RuntimeException(e); }
        });

        test("R4 cancel closes a deferred session before any business response", () -> {
            try (LanSyncTransport host = transport()) {
                LanSyncTransport.StartResult started = host.startHostDeferredForTest("db-r4-cancel", bytes(""), 20_000L);
                check("STARTED".equals(started.status), "deferred host did not start");
                check(host.stopHost(), "host cancel was rejected");
                check("CANCELLED".equals(awaitHost(host, "CANCELLED").status), "cancel status missing");
            } catch (Exception e) { throw new RuntimeException(e); }
        });

        test("R4 expiry closes a session while waiting for a phase response", () -> {
            try (LanSyncTransport host = transport()) {
                LanSyncTransport.StartResult started = host.startHostDeferredForTest("db-r4-expiry", bytes(""), 200L);
                check("STARTED".equals(started.status), "deferred host did not start");
                check("EXPIRED".equals(awaitHost(host, "EXPIRED").status), "expired deferred host remained active");
            } catch (Exception e) { throw new RuntimeException(e); }
        });

        test("R4 fresh session rotates session id and one-time token", () -> {
            try (LanSyncTransport host = transport()) {
                LanSyncTransport.StartResult one = host.startHostDeferredForTest("db-r4-token", bytes(""), 20_000L);
                check("STARTED".equals(one.status), "first session failed");
                host.stopHost(); awaitHost(host, "CANCELLED");
                LanSyncTransport.StartResult two = host.startHostDeferredForTest("db-r4-token", bytes(""), 20_000L);
                check("STARTED".equals(two.status), "second session failed");
                check(!one.pairing.sessionId.equals(two.pairing.sessionId), "session id reused");
                check(!one.pairing.token.equals(two.pairing.token), "token reused");
                host.stopHost();
            } catch (Exception e) { throw new RuntimeException(e); }
        });

        if (failed != 0) throw new AssertionError("R4 native tests: " + passed + "/" + (passed + failed) + " passed");
        System.out.println("R4_NATIVE " + passed + "/" + passed + " PASS");
    }
}
