package ee.dold.techcontrol;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Temporary, one-shot, authenticated DOLD LAN transport.
 *
 * This class only transfers opaque byte arrays. It has no workbook, journal,
 * inspection, or defect dependency. Semantic synchronization stays in the
 * existing JavaScript engine.
 */
public final class LanSyncTransport implements AutoCloseable {
    public static final int PROTOCOL_VERSION = 1;
    public static final int MAX_PAYLOAD_BYTES = 1024 * 1024;
    public static final long DEFAULT_SESSION_MILLIS = 180_000L;

    private static final int MAGIC = 0x4454434c; // "DTCL"
    private static final byte TYPE_CHALLENGE = 1;
    private static final byte TYPE_AUTH = 2;
    private static final byte TYPE_RESPONSE = 3;
    private static final byte TYPE_PAYLOAD = 4;
    private static final byte TYPE_AUTH_RESULT = 5;
    private static final int HASH_BYTES = 32;
    private static final int TOKEN_BYTES = 32;
    private static final int SESSION_ID_BYTES = 16;
    private static final int MAX_TEXT_BYTES = 256;
    private static final int SERVER_POLL_MILLIS = 500;
    private static final int SOCKET_TIMEOUT_MILLIS = 12_000;
    private static final int DEFAULT_CONNECT_TIMEOUT_MILLIS = 4_000;

    public interface AddressProvider {
        InetAddress getLocalIpv4() throws IOException;
    }

    public static final class PairingInfo {
        public final int protocol;
        public final String host;
        public final int port;
        public final String sessionId;
        public final String token;
        public final long createdAt;
        public final long expiresAt;
        public final String lineage;

        public PairingInfo(int protocol, String host, int port, String sessionId,
                           String token, long createdAt, long expiresAt, String lineage) {
            this.protocol = protocol;
            this.host = host == null ? "" : host;
            this.port = port;
            this.sessionId = sessionId == null ? "" : sessionId;
            this.token = token == null ? "" : token;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.lineage = lineage == null ? "" : lineage;
        }

        public String toJson() {
            return "{\"protocol\":" + protocol
                    + ",\"host\":" + jsonString(host)
                    + ",\"port\":" + port
                    + ",\"sessionId\":" + jsonString(sessionId)
                    + ",\"token\":" + jsonString(token)
                    + ",\"createdAt\":" + createdAt
                    + ",\"expiresAt\":" + expiresAt
                    + ",\"lineage\":" + jsonString(lineage) + "}";
        }
    }

    public static final class StartResult {
        public final String status;
        public final PairingInfo pairing;
        public final String message;

        private StartResult(String status, PairingInfo pairing, String message) {
            this.status = status;
            this.pairing = pairing;
            this.message = message == null ? "" : message;
        }

        public String toJson() {
            String pairingJson = pairing == null ? "null" : pairing.toJson();
            return "{\"ok\":" + ("STARTED".equals(status))
                    + ",\"status\":" + jsonString(status)
                    + ",\"message\":" + jsonString(message)
                    + ",\"pairing\":" + pairingJson + "}";
        }
    }

    public static final class ClientResult {
        public final String status;
        public final byte[] payload;

        private ClientResult(String status, byte[] payload) {
            this.status = status;
            this.payload = payload == null ? new byte[0] : payload.clone();
        }

        public boolean isSuccess() { return "SUCCESS".equals(status); }
    }

    public static final class HostStatus {
        public final String status;
        public final String error;
        public final PairingInfo pairing;
        public final byte[] receivedPayload;

        private HostStatus(String status, String error, PairingInfo pairing, byte[] receivedPayload) {
            this.status = status;
            this.error = error == null ? "" : error;
            this.pairing = pairing;
            this.receivedPayload = receivedPayload == null ? new byte[0] : receivedPayload.clone();
        }

        public boolean isListening() { return "WAITING".equals(status); }
    }

    public static final class ClientJob {
        public final String id;
        private volatile String state = "CONNECTING";
        private volatile ClientResult result;

        private ClientJob(String id) { this.id = id; }
        public String getState() { return state; }
        public ClientResult getResult() { return result; }
    }

    private final AddressProvider addressProvider;
    private final SecureRandom secureRandom = new SecureRandom();
    private final ExecutorService clientExecutor = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "DOLD-LAN-client");
        thread.setDaemon(true);
        return thread;
    });
    private final ConcurrentMap<String, ClientJob> clientJobs = new ConcurrentHashMap<>();
    private final java.util.Set<Socket> clientSockets = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private volatile HostSession activeHost;
    private volatile HostSession lastHost;

    public LanSyncTransport() {
        this(LanSyncTransport::findUsableLocalIpv4);
    }

    public LanSyncTransport(AddressProvider addressProvider) {
        this.addressProvider = addressProvider == null ? LanSyncTransport::findUsableLocalIpv4 : addressProvider;
    }

    public StartResult startHost(String dbId, byte[] responsePayload) {
        return startHostInternal(dbId, responsePayload, DEFAULT_SESSION_MILLIS, false, false);
    }

    /** Starts the same short-lived authenticated LAN session with two application-controlled exchanges. */
    public StartResult startHostDeferred(String dbId, byte[] responsePayload) {
        return startHostInternal(dbId, responsePayload, DEFAULT_SESSION_MILLIS, false, true);
    }

    /** Supplies a response to the currently pending exchange without giving the transport business-data access. */
    public boolean respondHost(byte[] responsePayload, boolean terminal) {
        HostSession session = activeHost;
        if (session == null) return false;
        byte[] response = responsePayload == null ? new byte[0] : responsePayload.clone();
        if (response.length > MAX_PAYLOAD_BYTES) return false;
        return session.provideResponse(response, terminal);
    }

    // Package-private duration override exists only for deterministic expiry tests.
    StartResult startHostForTest(String dbId, byte[] responsePayload, long lifetimeMillis) {
        return startHostInternal(dbId, responsePayload, lifetimeMillis, true, false);
    }

    StartResult startHostDeferredForTest(String dbId, byte[] responsePayload, long lifetimeMillis) {
        return startHostInternal(dbId, responsePayload, lifetimeMillis, true, true);
    }

    private synchronized StartResult startHostInternal(String dbId, byte[] responsePayload, long lifetimeMillis, boolean testLoopbackAllowed, boolean deferred) {
        if (closed.get()) return new StartResult("CLOSED", null, "Transport is closed.");
        HostSession existing = activeHost;
        if (existing != null && !existing.isTerminal()) {
            return new StartResult("SESSION_ACTIVE", existing.pairing, "A LAN session is already active.");
        }
        byte[] response = responsePayload == null ? new byte[0] : responsePayload.clone();
        if (response.length > MAX_PAYLOAD_BYTES) {
            return new StartResult("PAYLOAD_TOO_LARGE", null, "Payload exceeds the configured limit.");
        }
        if (lifetimeMillis < 50L || lifetimeMillis > 300_000L) {
            return new StartResult("INVALID_LIFETIME", null, "Session lifetime is outside the allowed range.");
        }
        InetAddress address;
        try {
            address = addressProvider.getLocalIpv4();
        } catch (Exception e) {
            address = null;
        }
        if (!(address instanceof Inet4Address) || (!isUsableIpv4(address) && !(testLoopbackAllowed && address.isLoopbackAddress()))) {
            return new StartResult("NO_LOCAL_NETWORK", null, "No usable local IPv4 network was found.");
        }

        ServerSocket server = null;
        try {
            server = new ServerSocket();
            server.setReuseAddress(false);
            server.bind(new InetSocketAddress(address, 0), 1);
            long createdAt = System.currentTimeMillis();
            long expiresAt = createdAt + lifetimeMillis;
            String sessionId = randomUrlToken(SESSION_ID_BYTES);
            String token = randomUrlToken(TOKEN_BYTES);
            String lineage = lineageFingerprint(dbId);
            PairingInfo pairing = new PairingInfo(PROTOCOL_VERSION, address.getHostAddress(),
                    server.getLocalPort(), sessionId, token, createdAt, expiresAt, lineage);
            HostSession session = new HostSession(this, server, pairing, response, deferred);
            activeHost = session;
            lastHost = session;
            session.start();
            return new StartResult("STARTED", pairing, "Waiting for one authenticated peer.");
        } catch (Exception e) {
            if (server != null) try { server.close(); } catch (IOException ignored) {}
            return new StartResult("BIND_FAILED", null, "Could not bind a temporary local listener.");
        }
    }

    public synchronized boolean stopHost() {
        return stopHostLocked(null);
    }

    /** Stops only the specified host session, so cleanup from an old flow cannot stop a newer QR. */
    public synchronized boolean stopHostForSession(String expectedSessionId) {
        if (expectedSessionId == null || expectedSessionId.isEmpty()) return false;
        return stopHostLocked(expectedSessionId);
    }

    private boolean stopHostLocked(String expectedSessionId) {
        HostSession session = activeHost;
        if (session == null || session.isTerminal()) return false;
        if (expectedSessionId != null && !expectedSessionId.equals(session.pairing.sessionId)) return false;
        session.cancel();
        return true;
    }

    public HostStatus getHostStatus() {
        HostSession session = activeHost;
        if (session == null) session = lastHost;
        return session == null ? new HostStatus("STOPPED", "", null, null) : session.snapshot();
    }

    public ClientResult exchange(PairingInfo pairing, String expectedDbId, byte[] requestPayload) {
        if(closed.get())return new ClientResult("CLOSED",null);
        String validation = validatePairing(pairing, expectedDbId, requestPayload);
        if (!"READY".equals(validation)) return new ClientResult(validation, null);
        byte[] request = requestPayload == null ? new byte[0] : requestPayload.clone();
        Socket socket = new Socket();
        clientSockets.add(socket);
        if(closed.get()){
            clientSockets.remove(socket);closeQuietly(socket);return new ClientResult("CLOSED",null);
        }
        try (Socket connectedSocket = socket) {
            connectedSocket.connect(new InetSocketAddress(InetAddress.getByName(pairing.host), pairing.port), DEFAULT_CONNECT_TIMEOUT_MILLIS);
            connectedSocket.setSoTimeout((int) Math.max(1L, Math.min(DEFAULT_SESSION_MILLIS,
                    pairing.expiresAt - System.currentTimeMillis())));
            DataInputStream in = new DataInputStream(connectedSocket.getInputStream());
            DataOutputStream out = new DataOutputStream(connectedSocket.getOutputStream());
            byte[] challenge = readChallenge(in);
            writeAuth(out, pairing, challenge);
            byte authStatus = readAuthResult(in);
            if(authStatus!=STATUS_SUCCESS)return new ClientResult(statusName(authStatus),null);
            writePayload(out, pairing, request, challenge);
            return readResponse(in, pairing, challenge);
        } catch (SocketTimeoutException e) {
            return new ClientResult("TIMEOUT", null);
        } catch (EOFException e) {
            return new ClientResult("INCOMPLETE_RESPONSE", null);
        } catch (WireException e) {
            return new ClientResult(e.status, null);
        } catch (IOException | GeneralSecurityException e) {
            return new ClientResult("CONNECTION_FAILED", null);
        } finally {
            clientSockets.remove(socket);
        }
    }

    public ClientJob startClient(PairingInfo pairing, String expectedDbId, byte[] requestPayload) {
        String id = randomUrlToken(SESSION_ID_BYTES);
        ClientJob job = new ClientJob(id);
        clientJobs.put(id, job);
        if (closed.get()) {
            job.result = new ClientResult("CLOSED", null);
            job.state = "DONE";
            return job;
        }
        try {
            clientExecutor.execute(() -> {
                ClientResult result = exchange(pairing, expectedDbId, requestPayload);
                job.result = result;
                job.state = "DONE";
            });
        } catch (RejectedExecutionException e) {
            job.result = new ClientResult("CLOSED", null);
            job.state = "DONE";
        }
        return job;
    }

    public ClientJob getClientJob(String id) {
        return id == null ? null : clientJobs.get(id);
    }

    public ClientJob consumeClientJob(String id) {
        return id == null ? null : clientJobs.remove(id);
    }

    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        stopHost();
        for (Socket socket : clientSockets) closeQuietly(socket);
        clientExecutor.shutdownNow();
        clientJobs.clear();
    }

    public static String lineageFingerprint(String dbId) {
        if (dbId == null || dbId.trim().isEmpty()) return "";
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(dbId.trim().getBytes(StandardCharsets.UTF_8));
            return toHex(hash);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private String randomUrlToken(int byteCount) {
        byte[] bytes = new byte[byteCount];
        secureRandom.nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String validatePairing(PairingInfo p, String expectedDbId, byte[] request) {
        if (p == null || p.protocol != PROTOCOL_VERSION) return "PROTOCOL_UNSUPPORTED";
        if (!isIpv4Literal(p.host) || p.port < 1 || p.port > 65535
                || !p.sessionId.matches("[A-Za-z0-9_-]{22}")
                || !p.token.matches("[A-Za-z0-9_-]{43}")
                || !(p.lineage.isEmpty() || p.lineage.matches("[a-f0-9]{64}"))) return "MALFORMED_PAIRING";
        if (p.expiresAt <= System.currentTimeMillis()) return "SESSION_EXPIRED";
        if (expectedDbId != null && !expectedDbId.trim().isEmpty()
                && !lineageFingerprint(expectedDbId).equals(p.lineage)) return "LINEAGE_MISMATCH";
        if (request != null && request.length > MAX_PAYLOAD_BYTES) return "PAYLOAD_TOO_LARGE";
        return "READY";
    }

    private static boolean isIpv4Literal(String value) {
        if (value == null || !value.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return false;
        try { return InetAddress.getByName(value) instanceof Inet4Address; }
        catch (Exception e) { return false; }
    }

    private static InetAddress findUsableLocalIpv4() throws IOException {
        Enumeration<NetworkInterface> enumeration = NetworkInterface.getNetworkInterfaces();
        if (enumeration == null) return null;
        List<InetAddress> localLanAddresses = new ArrayList<>();
        while (enumeration.hasMoreElements()) {
            NetworkInterface network = enumeration.nextElement();
            try {
                if (!network.isUp() || network.isLoopback()) continue;
            } catch (SocketException e) {
                continue;
            }
            String name = network.getName() == null ? "" : network.getName().toLowerCase(java.util.Locale.ROOT);
            if (name.startsWith("tun") || name.startsWith("tap") || name.startsWith("ppp")
                    || name.startsWith("wg") || name.startsWith("utun") || name.startsWith("rmnet")
                    || name.startsWith("ccmni") || name.startsWith("wwan") || name.startsWith("docker")
                    || name.startsWith("veth") || name.startsWith("br-")) continue;
            Enumeration<InetAddress> addresses = network.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (!(address instanceof Inet4Address) || !isUsableIpv4(address)) continue;
                if (name.startsWith("wlan") || name.startsWith("wifi") || name.startsWith("eth")
                        || name.startsWith("en") || name.startsWith("ap") || name.startsWith("swlan")) localLanAddresses.add(address);
            }
        }
        return localLanAddresses.isEmpty() ? null : localLanAddresses.get(0);
    }

    private static boolean isUsableIpv4(InetAddress address) {
        return address instanceof Inet4Address && !address.isAnyLocalAddress()
                && !address.isLoopbackAddress() && !address.isLinkLocalAddress()
                && !address.isMulticastAddress() && address.isSiteLocalAddress();
    }

    private static byte[] randomBytes(SecureRandom random, int count) {
        byte[] result = new byte[count];
        random.nextBytes(result);
        return result;
    }

    private static String jsonString(String value) {
        if (value == null) return "\"\"";
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    private static String toHex(byte[] value) {
        StringBuilder out = new StringBuilder(value.length * 2);
        for (byte b : value) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }

    private static byte[] sha256(byte[] value) throws GeneralSecurityException {
        return MessageDigest.getInstance("SHA-256").digest(value);
    }

    private static byte[] hmac(String token, byte[] challenge, String sessionId, String lineage,
                               int payloadLength, byte[] payloadHash) throws GeneralSecurityException, IOException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        ByteArrayOutputStream canonical = new ByteArrayOutputStream();
        DataOutputStream data = new DataOutputStream(canonical);
        data.writeInt(MAGIC);
        data.writeShort(PROTOCOL_VERSION);
        data.writeByte(TYPE_PAYLOAD);
        writeText(data, sessionId);
        writeText(data, lineage);
        data.writeInt(payloadLength);
        data.write(challenge);
        data.write(payloadHash);
        data.flush();
        return mac.doFinal(canonical.toByteArray());
    }

    private static byte[] authHmac(String token,byte[] challenge,String sessionId,String lineage)throws GeneralSecurityException,IOException{
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
        ByteArrayOutputStream canonical=new ByteArrayOutputStream();DataOutputStream data=new DataOutputStream(canonical);
        data.writeInt(MAGIC);data.writeShort(PROTOCOL_VERSION);data.writeByte(TYPE_AUTH);writeText(data,sessionId);writeText(data,lineage);data.write(challenge);data.flush();
        return mac.doFinal(canonical.toByteArray());
    }

    private static byte[] responseHmac(String token, byte[] challenge, byte status,
                                       int payloadLength, byte[] payloadHash) throws GeneralSecurityException, IOException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        ByteArrayOutputStream canonical = new ByteArrayOutputStream();
        DataOutputStream data = new DataOutputStream(canonical);
        data.writeInt(MAGIC);
        data.writeShort(PROTOCOL_VERSION);
        data.writeByte(TYPE_RESPONSE);
        data.writeByte(status);
        data.writeInt(payloadLength);
        data.write(challenge);
        data.write(payloadHash);
        data.flush();
        return mac.doFinal(canonical.toByteArray());
    }

    private static void writeText(DataOutputStream out, String value) throws IOException {
        byte[] bytes = (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_TEXT_BYTES) throw new IOException("Protocol text field is too long.");
        out.writeShort(bytes.length);
        out.write(bytes);
    }

    private static String readText(DataInputStream in) throws IOException {
        int length = in.readUnsignedShort();
        if (length > MAX_TEXT_BYTES) throw new WireException("MALFORMED_REQUEST");
        byte[] bytes = new byte[length];
        in.readFully(bytes);
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new WireException("MALFORMED_REQUEST");
        }
    }

    private static byte[] readChallenge(DataInputStream in) throws IOException {
        try {
            if (in.readInt() != MAGIC) throw new WireException("MALFORMED_RESPONSE");
            int version = in.readUnsignedShort();
            if (version != PROTOCOL_VERSION) throw new WireException("PROTOCOL_UNSUPPORTED");
            if (in.readByte() != TYPE_CHALLENGE) throw new WireException("MALFORMED_RESPONSE");
            byte[] challenge = new byte[HASH_BYTES];
            in.readFully(challenge);
            return challenge;
        } catch (EOFException e) {
            throw new WireException("INCOMPLETE_RESPONSE");
        }
    }

    private static void writeAuth(DataOutputStream out,PairingInfo pairing,byte[] challenge)throws IOException,GeneralSecurityException{
        byte[] mac=authHmac(pairing.token,challenge,pairing.sessionId,pairing.lineage);
        out.writeInt(MAGIC);out.writeShort(PROTOCOL_VERSION);out.writeByte(TYPE_AUTH);writeText(out,pairing.sessionId);writeText(out,pairing.lineage);out.write(mac);out.flush();
    }

    private static byte readAuthResult(DataInputStream in)throws IOException{
        try{
            if(in.readInt()!=MAGIC)throw new WireException("MALFORMED_RESPONSE");
            if(in.readUnsignedShort()!=PROTOCOL_VERSION)throw new WireException("PROTOCOL_UNSUPPORTED");
            if(in.readByte()!=TYPE_AUTH_RESULT)throw new WireException("MALFORMED_RESPONSE");
            return in.readByte();
        }catch(EOFException e){throw new WireException("INCOMPLETE_RESPONSE");}
    }

    private static void writePayload(DataOutputStream out, PairingInfo pairing,
                                     byte[] payload, byte[] challenge) throws IOException, GeneralSecurityException {
        byte[] hash = sha256(payload);
        byte[] mac = hmac(pairing.token, challenge, pairing.sessionId, pairing.lineage, payload.length, hash);
        out.writeInt(MAGIC);
        out.writeShort(PROTOCOL_VERSION);
        out.writeByte(TYPE_PAYLOAD);
        out.writeInt(payload.length);
        out.write(payload);
        out.write(hash);
        out.write(mac);
        out.flush();
    }

    private static ClientResult readResponse(DataInputStream in, PairingInfo pairing,
                                             byte[] challenge) throws IOException, GeneralSecurityException {
        try {
            if (in.readInt() != MAGIC) throw new WireException("MALFORMED_RESPONSE");
            if (in.readUnsignedShort() != PROTOCOL_VERSION) throw new WireException("PROTOCOL_UNSUPPORTED");
            if (in.readByte() != TYPE_RESPONSE) throw new WireException("MALFORMED_RESPONSE");
            byte status = in.readByte();
            int length = in.readInt();
            if (length < 0 || length > MAX_PAYLOAD_BYTES) throw new WireException("PAYLOAD_TOO_LARGE");
            byte[] payload = new byte[length];
            in.readFully(payload);
            byte[] hash = new byte[HASH_BYTES];
            byte[] suppliedMac = new byte[HASH_BYTES];
            in.readFully(hash);
            in.readFully(suppliedMac);
            if (status != STATUS_SUCCESS) return new ClientResult(statusName(status), null);
            byte[] actualHash = sha256(payload);
            if (!MessageDigest.isEqual(hash, actualHash)) throw new WireException("INTEGRITY_FAILURE");
            byte[] actualMac = responseHmac(pairing.token, challenge, status, length, hash);
            if (!MessageDigest.isEqual(suppliedMac, actualMac)) throw new WireException("AUTH_FAILED");
            return new ClientResult("SUCCESS", payload);
        } catch (EOFException e) {
            throw new WireException("INCOMPLETE_RESPONSE");
        }
    }

    private static final byte STATUS_SUCCESS = 0;
    private static final byte STATUS_AUTH_FAILED = 1;
    private static final byte STATUS_SESSION_EXPIRED = 2;
    private static final byte STATUS_PROTOCOL_UNSUPPORTED = 3;
    private static final byte STATUS_MALFORMED = 4;
    private static final byte STATUS_TOO_LARGE = 5;
    private static final byte STATUS_INCOMPLETE = 6;
    private static final byte STATUS_INTEGRITY = 7;

    private static byte statusCode(String status) {
        if ("SUCCESS".equals(status)) return STATUS_SUCCESS;
        if ("AUTH_FAILED".equals(status)) return STATUS_AUTH_FAILED;
        if ("SESSION_EXPIRED".equals(status)) return STATUS_SESSION_EXPIRED;
        if ("PROTOCOL_UNSUPPORTED".equals(status)) return STATUS_PROTOCOL_UNSUPPORTED;
        if ("PAYLOAD_TOO_LARGE".equals(status)) return STATUS_TOO_LARGE;
        if ("INCOMPLETE_REQUEST".equals(status)) return STATUS_INCOMPLETE;
        if ("INTEGRITY_FAILURE".equals(status)) return STATUS_INTEGRITY;
        return STATUS_MALFORMED;
    }

    private static String statusName(byte status) {
        switch (status) {
            case STATUS_SUCCESS: return "SUCCESS";
            case STATUS_AUTH_FAILED: return "AUTH_FAILED";
            case STATUS_SESSION_EXPIRED: return "SESSION_EXPIRED";
            case STATUS_PROTOCOL_UNSUPPORTED: return "PROTOCOL_UNSUPPORTED";
            case STATUS_TOO_LARGE: return "PAYLOAD_TOO_LARGE";
            case STATUS_INCOMPLETE: return "INCOMPLETE_REQUEST";
            case STATUS_INTEGRITY: return "INTEGRITY_FAILURE";
            default: return "MALFORMED_REQUEST";
        }
    }

    private static final class Request {
        final String sessionId;
        final String lineage;
        final byte[] payload;
        Request(String sessionId, String lineage, byte[] payload) {
            this.sessionId = sessionId;
            this.lineage = lineage;
            this.payload = payload;
        }
    }

    private static final class WireException extends IOException {
        private static final long serialVersionUID = 1L;
        final String status;
        WireException(String status) { super(status); this.status = status; }
    }

    private static final class HostSession {
        private final LanSyncTransport owner;
        private final ServerSocket server;
        private final PairingInfo pairing;
        private final byte[] responsePayload;
        private final boolean deferred;
        private final Object responseLock = new Object();
        private final SecureRandom random = new SecureRandom();
        private volatile Socket currentSocket;
        private volatile String state = "WAITING";
        private volatile String error = "";
        private volatile byte[] receivedPayload;
        private volatile InetAddress pairedAddress;
        private byte[] pendingResponse;
        private boolean pendingResponseTerminal;
        private boolean responseReady;
        private int exchangeCount;
        private final AtomicBoolean terminal = new AtomicBoolean(false);
        private final Thread thread;

        HostSession(LanSyncTransport owner, ServerSocket server, PairingInfo pairing, byte[] responsePayload, boolean deferred) {
            this.owner = owner;
            this.server = server;
            this.pairing = pairing;
            this.responsePayload = responsePayload.clone();
            this.deferred = deferred;
            this.thread = new Thread(this::run, "DOLD-LAN-host-" + pairing.port);
            this.thread.setDaemon(true);
        }

        void start() { thread.start(); }
        boolean isTerminal() { return terminal.get(); }

        HostStatus snapshot() {
            return new HostStatus(state, error, pairing, receivedPayload);
        }

        void cancel() {
            terminate("CANCELLED", "");
            synchronized (responseLock) { responseLock.notifyAll(); }
        }

        boolean provideResponse(byte[] payload, boolean terminalResponse) {
            if (!deferred || terminal.get()) return false;
            synchronized (responseLock) {
                if (responseReady || !("REQUEST_RECEIVED".equals(state) || "ACK_RECEIVED".equals(state))) return false;
                pendingResponse = payload == null ? new byte[0] : payload.clone();
                pendingResponseTerminal = terminalResponse;
                responseReady = true;
                // Consume the visible request event synchronously. WebView polling must not
                // observe the same REQUEST_RECEIVED / ACK_RECEIVED while the socket worker
                // is still waking up to write this response.
                state = "RESPONSE_QUEUED";
                responseLock.notifyAll();
                return true;
            }
        }

        private void run() {
            if (deferred) {
                runDeferred();
                return;
            }
            runSingleExchange();
        }

        private void runSingleExchange() {
            try {
                while (!terminal.get()) {
                    long remaining = pairing.expiresAt - System.currentTimeMillis();
                    if (remaining <= 0L) {
                        terminate("EXPIRED", "");
                        return;
                    }
                    server.setSoTimeout((int) Math.max(50L, Math.min(SERVER_POLL_MILLIS, remaining)));
                    Socket accepted;
                    try {
                        accepted = server.accept();
                    } catch (SocketTimeoutException e) {
                        continue;
                    }
                    currentSocket = accepted;
                    if(terminal.get()){
                        closeQuietly(accepted);currentSocket=null;return;
                    }
                    try (Socket socket = accepted) {
                        socket.setSoTimeout((int) Math.max(500L, Math.min(SOCKET_TIMEOUT_MILLIS, remaining)));
                        DataInputStream in = new DataInputStream(socket.getInputStream());
                        DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                        byte[] challenge = randomBytes(random, HASH_BYTES);
                        writeChallenge(out, challenge);
                        try {
                            readAuthentication(in,pairing,challenge);
                            if(System.currentTimeMillis()>=pairing.expiresAt){writeAuthResult(out,STATUS_SESSION_EXPIRED);terminate("EXPIRED","");return;}
                            writeAuthResult(out,STATUS_SUCCESS);
                        } catch (WireException e) {
                            writeAuthResult(out,statusCode(e.status));
                            if (!"AUTH_FAILED".equals(e.status)) terminate("ERROR",e.status);
                            continue;
                        }
                        Request request;
                        try {
                            request = readPayload(in, pairing, challenge);
                        } catch (WireException e) {
                            writeResponse(out, statusCode(e.status), new byte[0], challenge, pairing.token);
                            if (!"AUTH_FAILED".equals(e.status)) {
                                terminate("ERROR", e.status);
                            }
                            continue;
                        }
                        if (System.currentTimeMillis() >= pairing.expiresAt) {
                            writeResponse(out, STATUS_SESSION_EXPIRED, new byte[0], challenge, pairing.token);
                            terminate("EXPIRED", "");
                            return;
                        }
                        receivedPayload = request.payload.clone();
                        writeResponse(out, STATUS_SUCCESS, responsePayload, challenge, pairing.token);
                        terminate("COMPLETED", "");
                        return;
                    } catch (SocketTimeoutException e) {
                        if (System.currentTimeMillis() >= pairing.expiresAt) terminate("EXPIRED", "");
                        else terminate("ERROR", "INCOMPLETE_REQUEST");
                        return;
                    } catch (IOException | GeneralSecurityException e) {
                        if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
                        return;
                    } finally {
                        currentSocket = null;
                    }
                }
            } catch (IOException e) {
                if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
            } finally {
                if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
            }
        }

        /**
         * A bounded two-exchange session: proposal bytes, then the client's post-commit delta/receipt.
         * Both exchanges use fresh challenges and the same short-lived QR session. The LAN layer only
         * forwards opaque bytes; WebView code validates/applies semantic sync packages.
         */
        private void runDeferred() {
            try {
                while (!terminal.get() && exchangeCount < 2) {
                    long remaining = pairing.expiresAt - System.currentTimeMillis();
                    if (remaining <= 0L) { terminate("EXPIRED", ""); return; }
                    server.setSoTimeout((int) Math.max(50L, Math.min(SERVER_POLL_MILLIS, remaining)));
                    Socket accepted;
                    try { accepted = server.accept(); }
                    catch (SocketTimeoutException e) { continue; }
                    currentSocket = accepted;
                    if (terminal.get()) { closeQuietly(accepted); currentSocket = null; return; }
                    try (Socket socket = accepted) {
                        remaining = pairing.expiresAt - System.currentTimeMillis();
                        if (remaining <= 0L) { terminate("EXPIRED", ""); return; }
                        socket.setSoTimeout((int) Math.max(500L, Math.min(DEFAULT_SESSION_MILLIS, remaining)));
                        DataInputStream in = new DataInputStream(socket.getInputStream());
                        DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                        byte[] challenge = randomBytes(random, HASH_BYTES);
                        writeChallenge(out, challenge);
                        try {
                            readAuthentication(in, pairing, challenge);
                            if (pairedAddress != null && !pairedAddress.equals(socket.getInetAddress())) {
                                writeAuthResult(out, STATUS_AUTH_FAILED);
                                continue;
                            }
                            if (System.currentTimeMillis() >= pairing.expiresAt) {
                                writeAuthResult(out, STATUS_SESSION_EXPIRED); terminate("EXPIRED", ""); return;
                            }
                            writeAuthResult(out, STATUS_SUCCESS);
                        } catch (WireException e) {
                            writeAuthResult(out, statusCode(e.status));
                            if (!"AUTH_FAILED".equals(e.status)) terminate("ERROR", e.status);
                            continue;
                        }
                        Request request;
                        try { request = readPayload(in, pairing, challenge); }
                        catch (WireException e) {
                            writeResponse(out, statusCode(e.status), new byte[0], challenge, pairing.token);
                            if (!"AUTH_FAILED".equals(e.status)) terminate("ERROR", e.status);
                            continue;
                        }
                        if (System.currentTimeMillis() >= pairing.expiresAt) {
                            writeResponse(out, STATUS_SESSION_EXPIRED, new byte[0], challenge, pairing.token);
                            terminate("EXPIRED", ""); return;
                        }
                        if (exchangeCount == 0) pairedAddress = socket.getInetAddress();
                        receivedPayload = request.payload.clone();
                        byte[] response;
                        boolean terminalResponse;
                        synchronized (responseLock) {
                            // Clear the previous exchange before publishing the new event.
                            // State is volatile, so publishing it first would allow the
                            // JavaScript bridge to submit a response that this reset erases.
                            responseReady = false;
                            pendingResponse = null;
                            pendingResponseTerminal = false;
                            state = exchangeCount == 0 ? "REQUEST_RECEIVED" : "ACK_RECEIVED";
                            long responseDeadline = pairing.expiresAt;
                            while (!responseReady && !terminal.get()) {
                                long wait = responseDeadline - System.currentTimeMillis();
                                if (wait <= 0L) break;
                                responseLock.wait(Math.min(wait, 500L));
                            }
                            if (terminal.get()) return;
                            if (!responseReady) { terminate("EXPIRED", ""); return; }
                            response = pendingResponse == null ? new byte[0] : pendingResponse.clone();
                            terminalResponse = pendingResponseTerminal;
                        }
                        writeResponse(out, STATUS_SUCCESS, response, challenge, pairing.token);
                        exchangeCount++;
                        if (terminalResponse || exchangeCount >= 2) { terminate("COMPLETED", ""); return; }
                        state = "WAITING_ACK";
                    } catch (SocketTimeoutException e) {
                        if (System.currentTimeMillis() >= pairing.expiresAt) terminate("EXPIRED", "");
                        else terminate("ERROR", "INCOMPLETE_REQUEST");
                        return;
                    } catch (IOException | GeneralSecurityException e) {
                        if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
                        return;
                    } finally {
                        currentSocket = null;
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
            } catch (IOException e) {
                if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
            } finally {
                if (!terminal.get()) terminate("ERROR", "TRANSPORT_ERROR");
            }
        }

        private static void writeChallenge(DataOutputStream out, byte[] challenge) throws IOException {
            out.writeInt(MAGIC);
            out.writeShort(PROTOCOL_VERSION);
            out.writeByte(TYPE_CHALLENGE);
            out.write(challenge);
            out.flush();
        }

        private static void writeAuthResult(DataOutputStream out,byte status)throws IOException{
            out.writeInt(MAGIC);out.writeShort(PROTOCOL_VERSION);out.writeByte(TYPE_AUTH_RESULT);out.writeByte(status);out.flush();
        }

        private static void readAuthentication(DataInputStream in,PairingInfo expected,byte[] challenge)
                throws IOException,GeneralSecurityException{
            try{
                if(in.readInt()!=MAGIC)throw new WireException("MALFORMED_REQUEST");
                if(in.readUnsignedShort()!=PROTOCOL_VERSION)throw new WireException("PROTOCOL_UNSUPPORTED");
                if(in.readByte()!=TYPE_AUTH)throw new WireException("MALFORMED_REQUEST");
                String sessionId=readText(in),lineage=readText(in);byte[] suppliedMac=new byte[HASH_BYTES];in.readFully(suppliedMac);
                byte[] actualMac=authHmac(expected.token,challenge,sessionId,lineage);
                if(!expected.sessionId.equals(sessionId)||!expected.lineage.equals(lineage)||!MessageDigest.isEqual(suppliedMac,actualMac))throw new WireException("AUTH_FAILED");
            }catch(EOFException e){throw new WireException("INCOMPLETE_REQUEST");}
        }

        private static Request readPayload(DataInputStream in, PairingInfo expected, byte[] challenge)
                throws IOException, GeneralSecurityException {
            try {
                if (in.readInt() != MAGIC) throw new WireException("MALFORMED_REQUEST");
                if (in.readUnsignedShort() != PROTOCOL_VERSION) throw new WireException("PROTOCOL_UNSUPPORTED");
                if (in.readByte() != TYPE_PAYLOAD) throw new WireException("MALFORMED_REQUEST");
                int length = in.readInt();
                if (length < 0) throw new WireException("MALFORMED_REQUEST");
                if (length > MAX_PAYLOAD_BYTES) throw new WireException("PAYLOAD_TOO_LARGE");
                byte[] payload = new byte[length];
                in.readFully(payload);
                byte[] suppliedHash = new byte[HASH_BYTES];
                byte[] suppliedMac = new byte[HASH_BYTES];
                in.readFully(suppliedHash);
                in.readFully(suppliedMac);
                byte[] actualMac = hmac(expected.token, challenge, expected.sessionId, expected.lineage, length, suppliedHash);
                if (!MessageDigest.isEqual(suppliedMac, actualMac)) throw new WireException("AUTH_FAILED");
                byte[] actualHash = sha256(payload);
                if (!MessageDigest.isEqual(suppliedHash, actualHash)) throw new WireException("INTEGRITY_FAILURE");
                return new Request(expected.sessionId, expected.lineage, payload);
            } catch (EOFException e) {
                throw new WireException("INCOMPLETE_REQUEST");
            }
        }

        private static void writeResponse(DataOutputStream out, byte status, byte[] payload,
                                          byte[] challenge, String token)
                throws IOException, GeneralSecurityException {
            byte[] safePayload = status == STATUS_SUCCESS ? payload : new byte[0];
            byte[] hash = sha256(safePayload);
            byte[] mac = responseHmac(token, challenge, status, safePayload.length, hash);
            out.writeInt(MAGIC);
            out.writeShort(PROTOCOL_VERSION);
            out.writeByte(TYPE_RESPONSE);
            out.writeByte(status);
            out.writeInt(safePayload.length);
            out.write(safePayload);
            out.write(hash);
            out.write(mac);
            out.flush();
        }

        private void terminate(String finalState, String finalError) {
            if (!terminal.compareAndSet(false, true)) return;
            state = finalState;
            error = finalError == null ? "" : finalError;
            closeQuietly(currentSocket);
            try { server.close(); } catch (IOException ignored) {}
            owner.onHostTerminated(this);
        }
    }

    private synchronized void onHostTerminated(HostSession session) {
        if (activeHost == session) activeHost = null;
    }

    private static void closeQuietly(Socket socket) {
        if (socket != null) try { socket.close(); } catch (IOException ignored) {}
    }

    private static void closeQuietly(ServerSocket socket) {
        if (socket != null) try { socket.close(); } catch (IOException ignored) {}
    }
}
