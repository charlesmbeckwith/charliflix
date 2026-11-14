package com.charliflix.player;

import android.app.Activity;
import android.app.Instrumentation;
import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.ParcelFileDescriptor;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.util.DisplayMetrics;
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
    public void testPictureInPictureSnapshotValidation() throws Exception {
        JSONObject data = new JSONObject("{\"playing\":true,\"pictureInPictureEnabled\":true,\"videoWidth\":640,\"videoHeight\":480,\"rect\":{\"x\":200,\"y\":70,\"width\":500,\"height\":375},\"viewportWidth\":720,\"viewportHeight\":492}");
        PipPlaybackState playing = PipPlaybackState.parse(JSONObject.quote(data.toString()));
        assertTrue(playing.eligible);
        assertTrue(playing.playing);
        assertEquals(4.0 / 3, playing.aspectRatio.doubleValue(), 0.0001);
        data.put("playing", false);
        PipPlaybackState paused = PipPlaybackState.parse(JSONObject.quote(data.toString()));
        assertFalse(paused.eligible);
        assertFalse(paused.playing);
        assertEquals("Pausing retains video geometry", playing.aspectRatio, paused.aspectRatio);
        data.put("playing", true).put("pictureInPictureEnabled", false);
        assertFalse(PipPlaybackState.parse(JSONObject.quote(data.toString())).eligible);
        data.put("pictureInPictureEnabled", "true");
        assertFalse("String booleans are not trusted", PipPlaybackState.parse(JSONObject.quote(data.toString())).eligible);
        data.put("pictureInPictureEnabled", true).put("videoHeight", 0);
        assertSame(PipPlaybackState.IDLE, PipPlaybackState.parse(JSONObject.quote(data.toString())));
        for (String invalid : new String[] { null, "null", "true", "{}", "\"invalid\"", JSONObject.quote(new String(new char[8193])) }) {
            assertSame(PipPlaybackState.IDLE, PipPlaybackState.parse(invalid));
        }
    }

    public void testLongChannelTextStaysInsideLandscapeAndPortraitLists() throws Exception {
        Instrumentation instrumentation = getInstrumentation();
        Context context = instrumentation.getTargetContext();
        String originalSize = shell("wm size");
        java.util.regex.Matcher sizes = java.util.regex.Pattern.compile("(?:Physical|Override) size: (\\d+x\\d+)").matcher(originalSize);
        String restoredSize = null;
        while (sizes.find()) restoredSize = sizes.group(1);
        assertNotNull("Original emulator display geometry available", restoredSize);
        Activity activity = null;
        try {
            shell("wm size 1080x810");
            Intent launch = new Intent().setClassName(context.getPackageName(), MainActivity.class.getName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = instrumentation.startActivitySync(launch);
            WebView web = awaitPlayer(activity);
            awaitJavascript(web, "innerWidth>innerHeight", "true");
            assertLongTextLayout(context, web, "landscape");
            shell("wm size 540x1032");
            awaitJavascript(web, "innerWidth<innerHeight&&innerWidth<=400", "true");
            assertFalse("Responsive screen-layout changes preserve the Activity", activity.isDestroyed());
            AtomicReference<WebView> portraitWeb = new AtomicReference<>();
            Activity portraitActivity = activity;
            instrumentation.runOnMainSync(() -> portraitWeb.set(findWebView(portraitActivity.findViewById(android.R.id.content))));
            assertSame("Responsive layout retains the same video WebView", web, portraitWeb.get());
            assertLongTextLayout(context, web, "portrait");
        } finally {
            if (activity != null) finishAndWait(activity);
            shell("wm size " + restoredSize);
        }
    }

    private void assertLongTextLayout(Context context, WebView web, String orientation) throws Exception {
        evaluate(web, "window.charliflixLayoutSmoke={ready:false};for(const card of document.querySelectorAll('.channel-card')){card.querySelector('.channel-name').textContent='Channel';card.querySelector('.channel-now').textContent='Show';const episode=card.querySelector('.channel-episode');if(episode){episode.hidden=false;episode.textContent='Episode'}}window.CharliflixScrollText?.refresh();requestAnimationFrame(()=>requestAnimationFrame(()=>window.charliflixLayoutSmoke.ready=true));true");
        awaitJavascript(web, "window.charliflixLayoutSmoke.ready===true", "true");
        evaluate(web, "window.charliflixLayoutSmoke={baseline:(()=>{const r=document.getElementById('screen').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()};for(const card of document.querySelectorAll('.channel-card')){card.querySelector('.channel-name').textContent='A Very Long Channel Name That Must Never Reach Into The Video Panel';card.querySelector('.channel-now').textContent='The Extremely Long Television Show Name And Its Special Anniversary Presentation';let episode=card.querySelector('.channel-episode');if(!episode){episode=document.createElement('span');episode.className='channel-episode';card.querySelector('.channel-copy').appendChild(episode)}episode.hidden=false;episode.textContent='Season 12 Episode 24: A Very Long Episode Name That Needs Its Own Scrolling Text Row'}window.CharliflixScrollText?.refresh();requestAnimationFrame(()=>requestAnimationFrame(()=>window.charliflixLayoutSmoke.ready=true));true");
        awaitJavascript(web, "window.charliflixLayoutSmoke.ready===true", "true");
        String encoded = evaluate(web, "JSON.stringify((()=>{const b=document.querySelector('.sidebar').getBoundingClientRect(),s=document.getElementById('screen').getBoundingClientRect();return {orientation:'" + orientation + "',width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,sidebarRight:b.right,baseline:window.charliflixLayoutSmoke.baseline,screen:{x:s.x,y:s.y,width:s.width,height:s.height},cards:[...document.querySelectorAll('.channel-card')].map(card=>{const r=card.getBoundingClientRect(),p=card.closest('section').getBoundingClientRect();return {right:r.right,sectionRight:p.right}}),scrollingLabels:document.querySelectorAll('.channel-card .scroll-text.is-overflowing').length}})())");
        String json = new JSONArray("[" + encoded + "]").getString(0);
        JSONObject evidence = new JSONObject(json);
        assertTrue("Long labels cannot widen the document", evidence.getDouble("documentWidth") <= evidence.getDouble("width") + 2);
        assertTrue("Long labels cannot grow the whole document", evidence.getDouble("documentHeight") <= evidence.getDouble("height") + 2);
        JSONArray cards = evidence.getJSONArray("cards");
        for (int i = 0; i < cards.length(); i++) {
            JSONObject card = cards.getJSONObject(i);
            assertTrue("Card remains inside the sidebar", card.getDouble("right") <= evidence.getDouble("sidebarRight") + 1);
            assertTrue("Card cannot overlap its neighboring section", card.getDouble("right") <= card.getDouble("sectionRight") + 1);
        }
        JSONObject before = evidence.getJSONObject("baseline"), after = evidence.getJSONObject("screen");
        for (String key : new String[] { "x", "y", "width", "height" }) {
            assertEquals("Long labels preserve the existing video " + key, before.getDouble(key), after.getDouble(key), 1.0);
        }
        assertTrue("Overflowing labels activate bounded scrolling", evidence.getInt("scrollingLabels") > 0);
        File directory = context.getExternalFilesDir(null);
        assertNotNull("Layout evidence directory available", directory);
        Files.write(new File(directory, "charliflix-layout-" + orientation + ".json").toPath(), json.getBytes(StandardCharsets.UTF_8));
        Bitmap image = stableScreenshot(context, web);
        try (FileOutputStream output = new FileOutputStream(new File(directory, "charliflix-layout-" + orientation + ".png"))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { image.recycle(); }
    }

    private Bitmap stableScreenshot(Context context, WebView web) throws Exception {
        // WebView layout can finish before the emulator compositor has replaced
        // the old orientation's surface. Let both settle before exporting proof.
        CountDownLatch visualState = new CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> web.postVisualStateCallback(android.os.SystemClock.uptimeMillis(),
                new WebView.VisualStateCallback() {
                    @Override public void onComplete(long requestId) { web.invalidate(); visualState.countDown(); }
                }));
        assertTrue("WebView reached the requested visual state", visualState.await(5, TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync();
        Thread.sleep(1000);
        getInstrumentation().waitForIdleSync();
        DisplayMetrics expected = new DisplayMetrics();
        getInstrumentation().runOnMainSync(() -> ((WindowManager) context.getSystemService(Context.WINDOW_SERVICE))
                .getDefaultDisplay().getRealMetrics(expected));
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("Native screenshot captured after layout settled", image);
        assertEquals("Screenshot width matches the current display", expected.widthPixels, image.getWidth());
        assertEquals("Screenshot height matches the current display", expected.heightPixels, image.getHeight());
        return image;
    }

    private String shell(String command) throws Exception {
        try (ParcelFileDescriptor descriptor = getInstrumentation().getUiAutomation().executeShellCommand(command);
             InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int length;
            while ((length = input.read(buffer)) != -1) { assertTrue(output.size() + length < 16384); output.write(buffer, 0, length); }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    public void testPictureInPictureLifecycleAndOrdinaryBackgroundSuspension() throws Exception {
        Instrumentation instrumentation = getInstrumentation();
        Context context = instrumentation.getTargetContext();
        assertTrue("Disposable emulator supports PiP", context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE));
        Intent launch = new Intent().setClassName(context.getPackageName(), MainActivity.class.getName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = instrumentation.startActivitySync(launch);
        WebView web = awaitPlayer(activity);
        try {
            // Synthetic eligibility exercises actual Android PiP and lifecycle;
            // no upstream TV media or claimed real-stream playback is involved.
            evaluate(web, "window.charliflixPipSmoke={eligible:true,suspends:0};window.charliflixAndroidState=()=>({playing:window.charliflixPipSmoke.eligible,pictureInPictureEnabled:true,videoWidth:640,videoHeight:480,rect:{x:100,y:70,width:500,height:375},viewportWidth:innerWidth,viewportHeight:innerHeight});const nativeSuspend=window.charliflixSuspend;window.charliflixSuspend=()=>{window.charliflixPipSmoke.suspends++;nativeSuspend?.()};true");
            awaitNativeFlag(activity, "pipEligible", true);
            assertTrue("Home gesture accepted", instrumentation.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME));
            awaitPictureInPicture(activity, true);
            awaitJavascript(web, "document.body.classList.contains('picture-in-picture')", "true");
            evaluate(web, "setTimeout(()=>window.charliflixPipSmoke.timer=true,25);true");
            awaitJavascript(web, "window.charliflixPipSmoke.timer===true", "true");
            assertEquals("Entering PiP must not suspend playback", "0", evaluate(web, "window.charliflixPipSmoke.suspends"));

            instrumentation.runOnMainSync(() -> context.startActivity(launch));
            awaitPictureInPicture(activity, false);
            awaitJavascript(web, "document.body.classList.contains('picture-in-picture')", "false");
            assertFalse("Single-task reentry preserves the player Activity", activity.isDestroyed());
            evaluate(web, "window.charliflixPipSmoke.eligible=false;true");
            awaitNativeFlag(activity, "pipEligible", false);
            assertTrue("Home gesture accepted while idle", instrumentation.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME));
            awaitNativeFlag(activity, "stopped", true);
            assertFalse("Paused playback stays out of PiP", activity.isInPictureInPictureMode());
            instrumentation.runOnMainSync(() -> context.startActivity(launch));
            awaitNativeFlag(activity, "stopped", false);
            assertEquals("Ordinary backgrounding suspends playback once", "1", evaluate(web, "window.charliflixPipSmoke.suspends"));
        } finally { finishAndWait(activity); }
    }

    private void awaitNativeFlag(Activity activity, String name, boolean expected) throws Exception {
        java.lang.reflect.Field field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        do {
            AtomicReference<Boolean> current = new AtomicReference<>();
            getInstrumentation().runOnMainSync(() -> {
                try { current.set(field.getBoolean(activity)); } catch (IllegalAccessException invalid) { throw new AssertionError(invalid); }
            });
            if (current.get() == expected) return;
            Thread.sleep(100);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        fail("Native flag " + name + " did not become " + expected);
    }

    private void awaitPictureInPicture(Activity activity, boolean expected) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        do {
            AtomicReference<Boolean> current = new AtomicReference<>();
            getInstrumentation().runOnMainSync(() -> current.set(activity.isInPictureInPictureMode()));
            if (current.get() == expected) return;
            Thread.sleep(100);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        fail("Activity PiP mode did not become " + expected);
    }

    private void awaitJavascript(WebView web, String script, String expected) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 5000;
        do {
            if (expected.equals(evaluate(web, script))) return;
            Thread.sleep(75);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        assertEquals(expected, evaluate(web, script));
    }

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
        assertEquals("Theme and watched history save before recreation", "true", evaluate(web,
                "window.CharliflixSettings.setTheme('purple')&&window.CharliflixHistory.setWatched({title:'Fixture Show',subtitle:'Fixture Episode',episode:'S01E01'}).ok"));

        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(MainActivity.class.getName(), null, false);
        Activity original = activity;
        instrumentation.runOnMainSync(original::recreate);
        Activity recreated = instrumentation.waitForMonitorWithTimeout(monitor, 10000);
        instrumentation.removeMonitor(monitor);
        assertNotNull("Activity recreated", recreated);
        WebView recreatedWeb = awaitPlayer(recreated);
        assertEquals("Theme selection survives Activity recreation", "\"purple\"", evaluate(recreatedWeb, "window.CharliflixSettings.getTheme()"));
        assertEquals("The saved theme is applied to the replacement document", "\"purple\"", evaluate(recreatedWeb, "document.documentElement.dataset.theme"));
        assertEquals("Watched history survives Activity recreation", "true", evaluate(recreatedWeb,
                "window.CharliflixHistory.isWatched({title:'Fixture Show',subtitle:'Fixture Episode',episode:'S01E01'})"));
        evaluate(recreatedWeb, "setTimeout(()=>document.body.dataset.charliflixSmokeTimer='fired',25);true");
        long timerDeadline = android.os.SystemClock.elapsedRealtime() + 3000;
        String timerState;
        do {
            timerState = evaluate(recreatedWeb, "document.body.dataset.charliflixSmokeTimer||''");
            if ("\"fired\"".equals(timerState)) break;
            Thread.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < timerDeadline);
        assertEquals("Activity recreation resumes process-wide WebView timers", "\"fired\"", timerState);
        JSONObject after = new JSONObject(get(origin + "/api/health"));
        assertEquals("Recreation reuses the same backend process", health.getLong("pid"), after.getLong("pid"));
        assertEquals("Recreation preserves the origin and preferences", origin, awaitReady(readyFile).getString("origin"));
        assertEquals("Test restores the default theme and clean fixture history", "true", evaluate(recreatedWeb,
                "window.CharliflixSettings.setTheme('teal')&&window.CharliflixHistory.clear().ok"));
        finishAndWait(recreated);
    }

    private void finishAndWait(Activity activity) throws Exception {
        getInstrumentation().runOnMainSync(activity::finish);
        long deadline = android.os.SystemClock.elapsedRealtime() + 5000;
        do {
            AtomicReference<Boolean> destroyed = new AtomicReference<>();
            getInstrumentation().runOnMainSync(() -> destroyed.set(activity.isDestroyed()));
            if (destroyed.get()) { getInstrumentation().waitForIdleSync(); return; }
            Thread.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        fail("Activity did not finish before the next test launch");
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
        String lastCount = "no WebView";
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            AtomicReference<WebView> current = new AtomicReference<>();
            getInstrumentation().runOnMainSync(() -> current.set(findWebView(activity.findViewById(android.R.id.content))));
            WebView web = current.get();
            if (web != null) {
                String count = evaluate(web, "document.querySelectorAll('.channel-card').length");
                lastCount = count;
                if (count.matches("[0-9]+") && Integer.parseInt(count) >= 10) return web;
            }
            Thread.sleep(150);
        }
        throw new AssertionError("Real player UI did not load its channel list (last count=" + lastCount
                + ", finishing=" + activity.isFinishing() + ", destroyed=" + activity.isDestroyed() + ")");
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
        Bitmap screenshot = stableScreenshot(context, web);
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
