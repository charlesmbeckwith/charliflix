package com.charliflix.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/** One embedded backend per application process, independent of Activity recreation. */
final class BackendRuntime {
    interface Listener { void onBackendState(String origin, String error); }

    private static final BackendRuntime INSTANCE = new BackendRuntime();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<WeakReference<Listener>> listeners = new ArrayList<>();
    private boolean started;
    private volatile boolean stopped;
    private String origin;
    private String error;

    static BackendRuntime get() { return INSTANCE; }
    private BackendRuntime() { }

    synchronized void attach(Listener listener) {
        listeners.removeIf(reference -> reference.get() == null || reference.get() == listener);
        listeners.add(new WeakReference<>(listener));
        final String currentOrigin = origin;
        final String currentError = error;
        main.post(() -> listener.onBackendState(currentOrigin, currentError));
    }

    synchronized void detach(Listener listener) {
        listeners.removeIf(reference -> reference.get() == null || reference.get() == listener);
    }

    synchronized void ensureStarted(Context context) {
        if (started) return;
        started = true;
        Context application = context.getApplicationContext();
        new Thread(() -> bootstrap(application), "Charliflix-bootstrap").start();
    }

    private void publish(String nextOrigin, String nextError) {
        List<WeakReference<Listener>> targets;
        synchronized (this) {
            if (nextOrigin != null && stopped) return;
            origin = nextOrigin;
            error = nextError;
            listeners.removeIf(reference -> reference.get() == null);
            targets = new ArrayList<>(listeners);
        }
        for (WeakReference<Listener> reference : targets) {
            main.post(() -> {
                Listener target = reference.get();
                if (target != null) target.onBackendState(nextOrigin, nextError);
            });
        }
    }

    private void bootstrap(Context context) {
        try {
            File player = extractPlayer(context);
            File runtime = new File(context.getFilesDir(), "runtime");
            if (!runtime.isDirectory() && !runtime.mkdirs()) throw new IllegalStateException("Runtime directory unavailable");
            File ready = new File(runtime, "ready.json");
            if (ready.exists() && !ready.delete()) throw new IllegalStateException("Stale startup marker");
            SharedPreferences preferences = context.getSharedPreferences("backend", Context.MODE_PRIVATE);
            int preferred = preferences.getInt("port", 18767);
            if (preferred < 1024 || preferred > 65535) preferred = 18767;
            final String[] arguments = { "node", new File(player, "android-entry.cjs").getAbsolutePath(),
                    ready.getAbsolutePath(), Integer.toString(preferred) };
            System.loadLibrary("node");
            System.loadLibrary("charliflix");
            new Thread(() -> {
                try {
                    int code = startNode(arguments, context.getCacheDir().getAbsolutePath());
                    stopped = true;
                    Log.e("Charliflix", "Embedded backend stopped with code " + code);
                    publish(null, "The local player stopped. Force stop Charliflix in Android settings, then open it again.");
                } catch (Throwable failure) {
                    stopped = true;
                    Log.e("Charliflix", "Embedded runtime failure: " + failure.getClass().getSimpleName());
                    publish(null, "The local player stopped. Force stop Charliflix in Android settings, then open it again.");
                }
            }, "Charliflix-node").start();

            long deadline = android.os.SystemClock.elapsedRealtime() + 40_000;
            while (!stopped && android.os.SystemClock.elapsedRealtime() < deadline) {
                if (ready.isFile() && ready.length() > 0 && ready.length() <= 4096) {
                    String readyOrigin = readReady(ready);
                    if (readyOrigin != null && checkHealth(readyOrigin)) {
                        if (stopped) return;
                        preferences.edit().putInt("port", URI.create(readyOrigin).getPort()).apply();
                        publish(readyOrigin, null);
                        return;
                    }
                }
                Thread.sleep(150);
            }
            if (!stopped) publish(null, "The local player took too long to start. Force stop Charliflix in Android settings, then open it again.");
        } catch (Throwable failure) {
            Log.e("Charliflix", "Startup failed: " + failure.getClass().getSimpleName());
            publish(null, "The local player could not start. Force stop Charliflix in Android settings, then open it again.");
        }
    }

    private static String readReady(File ready) throws Exception {
        JSONObject data = new JSONObject(new String(Files.readAllBytes(ready.toPath()), StandardCharsets.UTF_8));
        if (!BuildConfig.VERSION_NAME.equals(data.optString("version"))) return null;
        String value = data.optString("origin");
        if (value.length() > 64) return null;
        URI uri = new URI(value);
        if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost())
                || uri.getPort() < 1024 || uri.getPort() > 65535 || uri.getUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty())) return null;
        return "http://127.0.0.1:" + uri.getPort();
    }

    private static boolean checkHealth(String origin) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            connection.setInstanceFollowRedirects(false);
            if (connection.getResponseCode() != 200) return false;
            JSONObject health;
            try (InputStream input = connection.getInputStream()) {
                health = new JSONObject(new String(readBounded(input, 4096), StandardCharsets.UTF_8));
            }
            return "channel-room".equals(health.optString("application"))
                    && BuildConfig.VERSION_NAME.equals(health.optString("version"));
        } catch (Exception failure) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static File extractPlayer(Context context) throws Exception {
        File root = new File(context.getFilesDir(), "player-v" + BuildConfig.VERSION_CODE);
        File marker = new File(root, ".complete");
        if (marker.isFile()) return root;
        if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("Player directory unavailable");
        JSONArray files;
        try (InputStream input = context.getAssets().open("player-files.json")) {
            files = new JSONArray(new String(readBounded(input, 1024 * 1024), StandardCharsets.UTF_8));
        }
        if (files.length() < 1 || files.length() > 4096) throw new IllegalStateException("Invalid player manifest");
        String prefix = root.getCanonicalPath() + File.separator;
        long total = 0;
        for (int i = 0; i < files.length(); i++) {
            String name = files.getString(i);
            if (name.length() > 512 || !name.matches("[A-Za-z0-9_./@-]+")
                    || name.startsWith("/") || name.contains("//")) throw new IllegalStateException("Invalid player path");
            for (String part : name.split("/")) {
                if (part.equals(".") || part.equals("..")) throw new IllegalStateException("Invalid player path");
            }
            File destination = new File(root, name);
            if (!destination.getCanonicalPath().startsWith(prefix)) throw new IllegalStateException("Invalid player path");
            File parent = destination.getParentFile();
            if (!parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException("Player directory unavailable");
            try (InputStream input = context.getAssets().open("player/" + name);
                 FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[16384];
                int length;
                long size = 0;
                while ((length = input.read(buffer)) != -1) {
                    size += length;
                    total += length;
                    if (size > 32 * 1024 * 1024 || total > 80 * 1024 * 1024) throw new IllegalStateException("Player bundle too large");
                    output.write(buffer, 0, length);
                }
            }
        }
        if (!new File(root, "android-entry.cjs").isFile() || !new File(root, "server.cjs").isFile()) {
            throw new IllegalStateException("Player entry missing");
        }
        try (FileOutputStream output = new FileOutputStream(marker)) {
            output.write(BuildConfig.VERSION_NAME.getBytes(StandardCharsets.UTF_8));
        }
        return root;
    }

    private static byte[] readBounded(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int length;
        while ((length = input.read(buffer)) != -1) {
            if (output.size() + length > limit) throw new IllegalStateException("Local metadata too large");
            output.write(buffer, 0, length);
        }
        return output.toByteArray();
    }

    private static native int startNode(String[] arguments, String cacheDirectory);
}
