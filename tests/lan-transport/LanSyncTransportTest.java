package ee.dold.techcontrol;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Standalone JVM tests for the native LAN protocol core; no Android device needed. */
public final class LanSyncTransportTest {
    private static final int MAGIC = 0x4454434c;
    private static final byte TYPE_CHALLENGE = 1;
    private static final byte TYPE_AUTH = 2;
    private static final byte TYPE_RESPONSE = 3;
    private static final byte TYPE_PAYLOAD = 4;
    private static final byte TYPE_AUTH_RESULT = 5;
    private static final int HASH_BYTES = 32;
    private static final int MAX_TEXT_BYTES = 256;
    private static final byte STATUS_SUCCESS = 0;
    private static final byte STATUS_AUTH_FAILED = 1;
    private static final byte STATUS_EXPIRED = 2;
    private static final byte STATUS_TOO_LARGE = 5;
    private static final byte STATUS_INTEGRITY = 7;

    private interface Case { void run() throws Exception; }
    private static int passed;
    private static int failed;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        Path transportSource = args.length > 0 ? Path.of(args[0]) : Path.of("app/src/main/java/ee/dold/techcontrol/LanSyncTransport.java");
        Path syncSource = args.length > 1 ? Path.of(args[1]) : Path.of("app/src/main/assets/DOLD_TechControl_v0.5.3.js");
        test("01 session creation returns IPv4 pairing fields", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.StartResult started = host(transport, "db-alpha", bytes("reply"));
                check("STARTED".equals(started.status), "host did not start: " + started.status);
                LanSyncTransport.PairingInfo p = started.pairing;
                check(p.protocol == 1 && p.port > 0 && p.port <= 65535, "protocol/port invalid");
                check("127.0.0.1".equals(p.host) && p.expiresAt > p.createdAt, "address/timestamps invalid");
                check(p.lineage.equals(LanSyncTransport.lineageFingerprint("db-alpha")), "lineage not fingerprinted");
                transport.stopHost();
            }
        });
        test("02 token has at least 256 bits of URL-safe entropy", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.StartResult started = host(transport, "db", new byte[0]);
                check(started.pairing.token.matches("[A-Za-z0-9_-]{43}"), "unexpected token representation");
                transport.stopHost();
            }
        });
        test("03 correct token completes authenticated request-response round-trip", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db-alpha", bytes("phone-a-response")).pairing;
                LanSyncTransport.ClientResult result = transport.exchange(p, "db-alpha", bytes("phone-b-request"));
                check(result.isSuccess() && text(result.payload).equals("phone-a-response"), "response payload mismatch: " + result.status);
                LanSyncTransport.HostStatus status = awaitTerminal(transport, "COMPLETED");
                check(text(status.receivedPayload).equals("phone-b-request"), "host request payload mismatch");
            }
        });
        test("04 asynchronous client job reports the response without blocking the bridge API", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db-alpha", bytes("async-response")).pairing;
                LanSyncTransport.ClientJob job = transport.startClient(p,"db-alpha",bytes("async-request"));
                long deadline=System.currentTimeMillis()+3000L;
                while(!"DONE".equals(job.getState())&&System.currentTimeMillis()<deadline)Thread.sleep(10L);
                check("DONE".equals(job.getState()),"asynchronous client job did not finish");
                check(job.getResult()!=null&&job.getResult().isSuccess()&&text(job.getResult().payload).equals("async-response"),"asynchronous response mismatch");
                check("COMPLETED".equals(awaitTerminal(transport,"COMPLETED").status),"host did not complete async request");
            }
        });
        test("05 wrong token is rejected before payload and does not terminate the host session", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                LanSyncTransport.PairingInfo wrong = copy(p, p.sessionId, "x".repeat(43), p.expiresAt, p.protocol, p.lineage);
                check("AUTH_FAILED".equals(transport.exchange(wrong, "db", bytes("x")).status), "wrong token accepted");
                check(transport.getHostStatus().isListening(), "auth failure incorrectly closed the listener");
                check(transport.getHostStatus().receivedPayload.length==0,"server received payload before authentication");
                check(transport.exchange(p, "db", bytes("retry")).isSuccess(), "valid retry failed");
            }
        });
        test("06 wrong sessionId is rejected", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                LanSyncTransport.PairingInfo wrong = copy(p, "z".repeat(22), p.token, p.expiresAt, p.protocol, p.lineage);
                check("AUTH_FAILED".equals(transport.exchange(wrong, "db", bytes("x")).status), "wrong session accepted");
                check(transport.getHostStatus().isListening(), "wrong session terminated host");
                transport.stopHost();
            }
        });
        test("07 protocol mismatch is rejected before connection", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                check("PROTOCOL_UNSUPPORTED".equals(transport.exchange(copy(p,p.sessionId,p.token,p.expiresAt,2,p.lineage), "db", bytes("x")).status), "protocol mismatch not rejected");
                check(transport.getHostStatus().isListening(), "protocol mismatch reached host");
                transport.stopHost();
            }
        });
        test("08 expired pairing data is rejected before connection", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                check("SESSION_EXPIRED".equals(transport.exchange(copy(p,p.sessionId,p.token,System.currentTimeMillis()-1,p.protocol,p.lineage), "db", bytes("x")).status), "expired pairing accepted");
                check(transport.getHostStatus().isListening(), "expired copy contacted the host");
                transport.stopHost();
            }
        });
        test("09 database lineage mismatch is rejected before connection", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db-alpha", bytes("ok")).pairing;
                check("LINEAGE_MISMATCH".equals(transport.exchange(p, "db-beta", bytes("x")).status), "different db lineage accepted");
                check(transport.getHostStatus().isListening(), "lineage mismatch contacted the host");
                transport.stopHost();
            }
        });
        test("10 cancel closes the listener and prevents reuse", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                check(transport.stopHost(), "cancel was not accepted");
                check("CANCELLED".equals(awaitTerminal(transport, "CANCELLED").status), "cancel status missing");
                check(!portAccepts(p), "listener remained open after cancel");
            }
        });
        test("11 expiry automatically closes the listener", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.StartResult started = transport.startHostForTest("db", bytes("ok"), 180L);
                check("STARTED".equals(started.status), "short test session did not start");
                LanSyncTransport.HostStatus status = awaitTerminal(transport, "EXPIRED");
                check("EXPIRED".equals(status.status), "expiry state missing");
                check(!portAccepts(started.pairing), "listener remained open after expiry");
            }
        });
        test("12 successful terminal exchange closes the listener", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                check(transport.exchange(p, "db", bytes("request")).isSuccess(), "valid exchange failed");
                check("COMPLETED".equals(awaitTerminal(transport, "COMPLETED").status), "completion state missing");
                check(!portAccepts(p), "listener remained open after success");
            }
        });
        test("13 each new session gets a different token and sessionId", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo first = host(transport, "db", bytes("a")).pairing;
                transport.stopHost();
                LanSyncTransport.PairingInfo second = host(transport, "db", bytes("b")).pairing;
                check(!first.token.equals(second.token) && !first.sessionId.equals(second.sessionId), "session credentials were reused");
                transport.stopHost();
            }
        });
        test("14 a previous token/session cannot be reused after restart", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo old = host(transport, "db", bytes("a")).pairing;
                transport.stopHost();
                LanSyncTransport.PairingInfo current = host(transport, "db", bytes("b")).pairing;
                check(!transport.exchange(old, "db", bytes("replay")).isSuccess(), "old pairing reused");
                check(transport.exchange(current, "db", bytes("new")).isSuccess(), "fresh pairing failed");
            }
        });
        test("15 no local IPv4 reports NO_LOCAL_NETWORK", () -> {
            try (LanSyncTransport transport = new LanSyncTransport(() -> null)) {
                check("NO_LOCAL_NETWORK".equals(transport.startHost("db", bytes("x")).status), "missing network was not reported");
                check("STOPPED".equals(transport.getHostStatus().status), "listener started without an address");
            }
        });
        test("16 malformed wire header is rejected and closes the session", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                byte status;
                try (Socket socket = connectAndReadChallenge(p)) {
                    DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                    out.writeInt(0x01020304);out.flush();status=readResponseStatus(new DataInputStream(socket.getInputStream()));
                }
                check(status == 4, "malformed frame status=" + status);
                check("ERROR".equals(awaitTerminal(transport, "ERROR").status), "malformed frame did not close session");
            }
        });
        test("17 truncated request is rejected safely and closes the session", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                Socket socket = connectAndReadChallenge(p);
                socket.getOutputStream().write(new byte[]{0x44,0x54});socket.getOutputStream().flush();socket.close();
                LanSyncTransport.HostStatus status = awaitTerminal(transport, "ERROR");
                check(!status.isListening(), "truncated request left listener active");
                check(!portAccepts(p), "listener remained open after truncated request");
            }
        });
        test("18 client payload above maximum is rejected locally", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                byte[] huge = new byte[LanSyncTransport.MAX_PAYLOAD_BYTES + 1];
                check("PAYLOAD_TOO_LARGE".equals(transport.exchange(p, "db", huge).status), "oversize client payload accepted");
                check(transport.getHostStatus().isListening(), "oversize local payload reached host");
                transport.stopHost();
            }
        });
        test("19 server rejects declared oversized frame before allocating payload", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                byte status;
                try (Socket socket = new Socket()) {
                    socket.connect(new java.net.InetSocketAddress(p.host,p.port),1000);socket.setSoTimeout(2000);
                    DataInputStream in=new DataInputStream(socket.getInputStream());byte[] challenge=readChallenge(in);
                    DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                    writeAuthentication(out,p,challenge);check(readAuthResult(in)==STATUS_SUCCESS,"server did not accept valid token before payload");
                    out.writeInt(MAGIC);out.writeShort(1);out.writeByte(TYPE_PAYLOAD);out.writeInt(LanSyncTransport.MAX_PAYLOAD_BYTES+1);out.flush();
                    status=readResponseStatus(in);
                }
                check(status==STATUS_TOO_LARGE, "server oversize status="+status);
                check("ERROR".equals(awaitTerminal(transport,"ERROR").status), "oversized frame did not close session");
            }
        });
        test("20 authenticated payload hash detects corruption", () -> {
            try (LanSyncTransport transport = loopback()) {
                LanSyncTransport.PairingInfo p = host(transport, "db", bytes("ok")).pairing;
                byte status;
                try (Socket socket = new Socket()) {
                    socket.connect(new java.net.InetSocketAddress(p.host,p.port),1000);socket.setSoTimeout(2000);
                    DataInputStream in=new DataInputStream(socket.getInputStream());byte[] challenge=readChallenge(in);
                    DataOutputStream out=new DataOutputStream(socket.getOutputStream());writeAuthentication(out,p,challenge);check(readAuthResult(in)==STATUS_SUCCESS,"authentication failed before payload test");byte[] payload=bytes("changed"),falseHash=new byte[HASH_BYTES];
                    byte[] mac=requestMac(p,challenge,payload.length,falseHash);
                    out.writeInt(MAGIC);out.writeShort(1);out.writeByte(TYPE_PAYLOAD);out.writeInt(payload.length);out.write(payload);out.write(falseHash);out.write(mac);out.flush();
                    status=readResponseStatus(in);
                }
                check(status==STATUS_INTEGRITY,"corrupt payload status="+status);
                check("ERROR".equals(awaitTerminal(transport,"ERROR").status),"corrupt frame did not close session");
            }
        });
        test("21 repeated start and stop releases each listener", () -> {
            try (LanSyncTransport transport = loopback()) {
                for(int i=0;i<20;i++){
                    LanSyncTransport.PairingInfo p=host(transport,"db",bytes("x")).pairing;
                    check(transport.stopHost(),"stop failed at iteration "+i);
                    awaitTerminal(transport,"CANCELLED");
                    check(!portAccepts(p),"listener leaked at iteration "+i);
                }
                LanSyncTransport.StartResult last=host(transport,"db",bytes("ok"));
                check("STARTED".equals(last.status),"listener could not restart after repeated stop");transport.stopHost();
            }
        });
        test("22 transport core has no file/workbook business-data dependency", () -> {
            String source=Files.readString(transportSource);
            check(!source.contains("WorkspaceStore")&&!source.contains("Kontrollid")&&!source.contains("Puudused"),"transport references business storage");
            check(!source.contains("FileOutputStream")&&!source.contains("Files.write"),"transport writes local files");
        });
        test("23 R1 semantic sync byte entry and file routing remain connected", () -> {
            String source=Files.readString(syncSource);
            check(source.contains("processSyncPackageBytes("),"shared sync byte entry was removed");
            check(source.contains("async function applySyncOperations(operations,senderDeviceId='',directConflictChoices=null)"),"single semantic merge engine signature was removed");
            check(source.contains("await applySyncOperations(operations,manifest.senderDeviceId||'',options.directProtocol?conflictChoices:null)"),"sync payload no longer uses the existing semantic merge engine");
            check(source.contains("detectIncomingFileKind(bytes,file.name)"),"manifest file routing was removed");
        });
        System.out.println("R2 LAN transport tests: " + passed + " / " + (passed+failed) + " PASS");
        if(failed>0){for(String failure:failures)System.err.println(failure);System.exit(1);}
    }

    private static void test(String name,Case test){
        try{test.run();passed++;System.out.println("PASS "+name);}catch(Throwable e){failed++;failures.add("FAIL "+name+": "+e);e.printStackTrace(System.err);}
    }

    private static LanSyncTransport loopback(){
        return new LanSyncTransport(() -> InetAddress.getByName("127.0.0.1"));
    }

    private static LanSyncTransport.StartResult host(LanSyncTransport transport,String db,byte[] response){
        LanSyncTransport.StartResult result=transport.startHostForTest(db,response,30_000L);
        check("STARTED".equals(result.status),"host start failed: "+result.status);
        return result;
    }

    private static LanSyncTransport.PairingInfo copy(LanSyncTransport.PairingInfo p,String session,String token,long expiry,int protocol,String lineage){
        return new LanSyncTransport.PairingInfo(protocol,p.host,p.port,session,token,p.createdAt,expiry,lineage);
    }

    private static LanSyncTransport.HostStatus awaitTerminal(LanSyncTransport transport,String expected) throws Exception {
        long deadline=System.currentTimeMillis()+3_000L;
        LanSyncTransport.HostStatus status;
        do{status=transport.getHostStatus();if(!"WAITING".equals(status.status))break;Thread.sleep(10L);}while(System.currentTimeMillis()<deadline);
        check(expected.equals(status.status),"expected host status "+expected+" but got "+status.status+"/"+status.error);
        return status;
    }

    private static boolean portAccepts(LanSyncTransport.PairingInfo p){
        try(Socket socket=new Socket()){socket.connect(new java.net.InetSocketAddress(p.host,p.port),150);return true;}
        catch(IOException e){return false;}
    }

    private static Socket connectAndReadChallenge(LanSyncTransport.PairingInfo p)throws Exception{
        Socket socket=new Socket();socket.connect(new java.net.InetSocketAddress(p.host,p.port),1000);socket.setSoTimeout(2000);
        DataInputStream in=new DataInputStream(socket.getInputStream());readChallenge(in);return socket;
    }

    private static byte[] readChallenge(DataInputStream in)throws Exception{
        check(in.readInt()==MAGIC,"challenge magic mismatch");check(in.readUnsignedShort()==1,"challenge protocol mismatch");
        check(in.readByte()==TYPE_CHALLENGE,"challenge type mismatch");byte[] challenge=new byte[HASH_BYTES];in.readFully(challenge);return challenge;
    }

    private static byte readResponseStatus(DataInputStream in)throws Exception{
        check(in.readInt()==MAGIC,"response magic mismatch");check(in.readUnsignedShort()==1,"response protocol mismatch");
        byte type=in.readByte();byte status=in.readByte();if(type==TYPE_AUTH_RESULT)return status;
        check(type==TYPE_RESPONSE,"response type mismatch");int n=in.readInt();
        check(n>=0&&n<=LanSyncTransport.MAX_PAYLOAD_BYTES,"response length invalid");byte[] skip=new byte[n];in.readFully(skip);
        byte[] hash=new byte[HASH_BYTES],mac=new byte[HASH_BYTES];in.readFully(hash);in.readFully(mac);return status;
    }

    private static void writeText(DataOutputStream out,String text)throws IOException{
        byte[] value=text.getBytes(StandardCharsets.UTF_8);if(value.length>MAX_TEXT_BYTES)throw new IOException("text too long");out.writeShort(value.length);out.write(value);
    }

    private static byte[] requestMac(LanSyncTransport.PairingInfo p,byte[] challenge,int length,byte[] suppliedHash)throws Exception{
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(p.token.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream out=new DataOutputStream(bytes);
        out.writeInt(MAGIC);out.writeShort(1);out.writeByte(TYPE_PAYLOAD);writeText(out,p.sessionId);writeText(out,p.lineage);out.writeInt(length);out.write(challenge);out.write(suppliedHash);out.flush();return mac.doFinal(bytes.toByteArray());
    }

    private static void writeAuthentication(DataOutputStream out,LanSyncTransport.PairingInfo p,byte[] challenge)throws Exception{
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(p.token.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream canonical=new DataOutputStream(bytes);
        canonical.writeInt(MAGIC);canonical.writeShort(1);canonical.writeByte(TYPE_AUTH);writeText(canonical,p.sessionId);writeText(canonical,p.lineage);canonical.write(challenge);canonical.flush();
        out.writeInt(MAGIC);out.writeShort(1);out.writeByte(TYPE_AUTH);writeText(out,p.sessionId);writeText(out,p.lineage);out.write(mac.doFinal(bytes.toByteArray()));out.flush();
    }

    private static byte readAuthResult(DataInputStream in)throws Exception{
        check(in.readInt()==MAGIC,"auth response magic mismatch");check(in.readUnsignedShort()==1,"auth response protocol mismatch");
        check(in.readByte()==TYPE_AUTH_RESULT,"auth response type mismatch");return in.readByte();
    }

    private static byte[] bytes(String value){return value.getBytes(StandardCharsets.UTF_8);}
    private static String text(byte[] value){return new String(value,StandardCharsets.UTF_8);}
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
}
