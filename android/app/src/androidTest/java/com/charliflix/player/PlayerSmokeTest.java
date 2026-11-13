package com.charliflix.player;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Boots the shipped native runtime and real WebView; no TV feed is started. */
@SuppressWarnings("deprecation")
public final class PlayerSmokeTest extends InstrumentationTestCase {
    public void testRemoteNavigationBoundaries() throws Exception {
        assertTrue(policy("isArchiveVideo", "https://archive.org/download/example/episode.mp4"));
        assertTrue(policy("isArchiveVideo", "https://ia800000.us.archive.org/12/items/example/episode.mp4"));
        for (String value : new String[] {
                "http://archive.org/download/example/episode.mp4", "https://archive.org.evil.example/download/episode.mp4",
                "https://archive.org@evil.example/download/episode.mp4", "https://user:secret@archive.org/download/example/episode.mp4",
                "https://archive.org:444/download/example/episode.mp4", "https://archive.org/download/example/script.js",
                "https://archive.org/services/example.mp4", "https://archive.org/download/example/episode.mp4#fragment",
                "https://evil.example/episode.mp4", "file:///sdcard/episode.mp4" }) {
            assertFalse("Reject remote video: " + value, policy("isArchiveVideo", value));
        }
        assertTrue(policy("isExternalLink", "https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.8"));
        assertTrue(policy("isExternalLink", "https://github.com/charlesmbeckwith/charliflix/releases/latest"));
        assertTrue(policy("isExternalLink", "https://spelunkr.tv/"));
        assertTrue(policy("isExternalLink", "https://epgtalk.com/api.html"));
        for (String value : new String[] {
                "https://github.com/other/project/releases/latest", "https://github.com.evil.example/charlesmbeckwith/charliflix/releases/latest",
                "https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.8?next=evil", "https://spelunkr.tv/sign-in",
                "https://epgtalk.com/api/now/us.json", "https://epgtalk.com.evil.example/api.html",
                "javascript:alert(1)", "intent://settings", "http://spelunkr.tv/" }) {
            assertFalse("Reject external link: " + value, policy("isExternalLink", value));
        }
    }

    private static boolean policy(String name, String value) throws Exception {
        java.lang.reflect.Method method = MainActivity.class.getDeclaredMethod(name, String.class);
        method.setAccessible(true);
        return (Boolean) method.invoke(null, value);
    }

    public void testEmbeddedBackendAndActivityRecreation() throws Exception {
        Instrumentation instrumentation = getInstrumentation();
        Context context = instrumentation.getTargetContext();
        Intent launch = new Intent().setClassName(context.getPackageName(), MainActivity.class.getName());
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = instrumentation.startActivitySync(launch);
        File readyFile = new File(context.getFilesDir(), "runtime/ready.json");
        JSONObject ready = awaitReady(readyFile);
        String origin = ready.getString("origin");
        URI uri = new URI(origin);
        assertEquals("http", uri.getScheme());
        assertEquals("127.0.0.1", uri.getHost());
        assertTrue(uri.getPort() >= 1024 && uri.getPort() <= 65535);
        assertEquals(BuildConfig.VERSION_NAME, ready.getString("version"));
        JSONObject health = new JSONObject(get(origin + "/api/health"));
        assertEquals("channel-room", health.getString("application"));
        assertEquals(BuildConfig.VERSION_NAME, health.getString("version"));
        assertTrue(health.getLong("pid") > 0);
        JSONObject channels = new JSONObject(get(origin + "/api/channels"));
        assertTrue(channels.getJSONArray("channels").length() >= 10);
        assertTrue(get(origin + "/app.js").contains("charliflixBack"));
        WebView web = awaitPlayer(activity);
        AtomicReference<Boolean> secure = new AtomicReference<>(false);
        instrumentation.runOnMainSync(() -> secure.set(!web.getSettings().getAllowFileAccess()
                && !web.getSettings().getAllowContentAccess()
                && !web.getSettings().getJavaScriptCanOpenWindowsAutomatically()));
        assertTrue("WebView access controls are enabled", secure.get());
        assertEquals("\"127.0.0.1\"", evaluate(web, "location.hostname"));
        saveUiEvidence(context, web);

        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(MainActivity.class.getName(), null, false);
        Activity original = activity;
        instrumentation.runOnMainSync(original::recreate);
        Activity recreated = instrumentation.waitForMonitorWithTimeout(monitor, 10000);
        instrumentation.removeMonitor(monitor);
        assertNotNull("Activity recreated", recreated);
        awaitPlayer(recreated);
        JSONObject after = new JSONObject(get(origin + "/api/health"));
        assertEquals("Recreation reuses the same backend process", health.getLong("pid"), after.getLong("pid"));
        assertEquals("Recreation preserves the origin and preferences", origin, awaitReady(readyFile).getString("origin"));
        Activity finished = recreated;
        instrumentation.runOnMainSync(finished::finish);
    }

    private JSONObject awaitReady(File file) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 45000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (file.isFile() && file.length() > 0 && file.length() <= 4096) {
                JSONObject ready = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                if (BuildConfig.VERSION_NAME.equals(ready.optString("version"))) {
                    try { get(ready.getString("origin") + "/api/health"); return ready; } catch (Exception notYet) { }
                }
            }
            Thread.sleep(150);
        }
        throw new AssertionError("Embedded runtime did not become ready");
    }

    private WebView awaitPlayer(Activity activity) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 20000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            AtomicReference<WebView> current = new AtomicReference<>();
            getInstrumentation().runOnMainSync(() -> current.set(findWebView(activity.findViewById(android.R.id.content))));
            WebView web = current.get();
            if (web != null) {
                String count = evaluate(web, "document.querySelectorAll('.channel-card').length");
                if (count.matches("[0-9]+") && Integer.parseInt(count) >= 10) return web;
            }
            Thread.sleep(150);
        }
        throw new AssertionError("Real player UI did not load its channel list");
    }

    private String evaluate(WebView web, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, result -> { value.set(result); done.countDown(); }));
        assertTrue("WebView script completed", done.await(5, TimeUnit.SECONDS));
        return value.get();
    }

    private void saveUiEvidence(Context context, WebView web) throws Exception {
        String result = evaluate(web, "JSON.stringify({width:innerWidth,height:innerHeight,documentHeight:document.documentElement.scrollHeight,channels:document.querySelectorAll('.channel-card').length,videoPaused:document.querySelector('video').paused,userAgent:navigator.userAgent})");
        String json = new JSONArray("[" + result + "]").getString(0);
        JSONObject layout = new JSONObject(json);
        assertTrue("The channel list must not stretch the whole window", layout.getInt("documentHeight") <= layout.getInt("height") + 2);
        assertTrue("Smoke test does not start an upstream stream", layout.getBoolean("videoPaused"));
        File directory = context.getExternalFilesDir(null);
        assertNotNull("Test evidence directory available", directory);
        Files.write(new File(directory, "charliflix-android-smoke.json").toPath(), json.getBytes(StandardCharsets.UTF_8));
        Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("Native Android screenshot captured", screenshot);
        try (FileOutputStream output = new FileOutputStream(new File(directory, "charliflix-android-smoke.png"))) {
            assertTrue("Android screenshot saved", screenshot.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { screenshot.recycle(); }
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private static String get(String value) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(value).openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(3000);
        connection.setInstanceFollowRedirects(false);
        try {
            if (connection.getResponseCode() != 200) throw new AssertionError("Local request failed");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] bytes = new byte[8192];
                int length;
                while ((length = input.read(bytes)) != -1) {
                    if (output.size() + length > 2 * 1024 * 1024) throw new AssertionError("Local response too large");
                    output.write(bytes, 0, length);
                }
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally { connection.disconnect(); }
    }
}
