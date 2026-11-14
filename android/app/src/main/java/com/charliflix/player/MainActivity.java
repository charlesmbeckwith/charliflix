package com.charliflix.player;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.lang.ref.WeakReference;
import java.net.URI;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity implements BackendRuntime.Listener {
    private static final int BACKGROUND = Color.rgb(11, 16, 20);
    private static WeakReference<MainActivity> visibleActivity = new WeakReference<>(null);
    private FrameLayout root;
    private WebView web;
    private TextView notice;
    private String origin;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean paused;
    private boolean backing;
    private boolean stopped;
    private boolean pipRequestPending;
    private boolean pipQueryPending;
    private boolean pipEligible;
    private String pipSignature;
    private PipPlaybackState pipState = PipPlaybackState.IDLE;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable pipPoll = new Runnable() {
        @Override public void run() {
            if (stopped || isFinishing() || isDestroyed()) return;
            queryPipState(false);
            main.postDelayed(this, 500);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        root.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> updatePipParams());
        setContentView(root);
        notice = new TextView(this);
        notice.setGravity(Gravity.CENTER);
        notice.setTextColor(Color.rgb(205, 225, 214));
        notice.setTextSize(17);
        int padding = Math.round(28 * getResources().getDisplayMetrics().density);
        notice.setPadding(padding, padding, padding, padding);
        notice.setText("Starting Charliflix…");
        root.addView(notice, matchParent());
        BackendRuntime.get().attach(this);
        BackendRuntime.get().ensureStarted(this);
        PipActionReceiver.attach(this);
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    @Override public void onBackendState(String nextOrigin, String error) {
        if (isFinishing() || isDestroyed()) return;
        if (error != null) {
            if (web != null) web.setVisibility(View.GONE);
            notice.setText(error);
            notice.setVisibility(View.VISIBLE);
            return;
        }
        if (nextOrigin == null || nextOrigin.equals(origin)) return;
        origin = nextOrigin;
        createWebView();
        web.loadUrl(origin + "/");
    }

    @SuppressWarnings("deprecation")
    private void createWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " CharliflixAndroid/" + BuildConfig.VERSION_NAME);
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> { });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String value = request.getUrl().toString();
                if (isLocal(value)) return false;
                if (request.isForMainFrame() && request.hasGesture() && isExternalLink(value)) openExternal(value);
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String value = request.getUrl().toString();
                if (isLocal(value)) return null;
                // Spelunkr's public MP4 source is the only direct remote media path.
                // All HLS streams, scripts, metadata and keys stay behind our backend.
                if (!request.isForMainFrame() && "GET".equals(request.getMethod()) && isArchiveVideo(value)) return null;
                return blocked();
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (!isLocal(url)) return;
                notice.setVisibility(View.GONE);
                if (!paused) view.requestFocus();
                queryPipState(false);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message message) { return false; }
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                // Do not copy stream addresses or upstream responses into Android logs.
                return true;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null) { callback.onCustomViewHidden(); return; }
                fullscreen = view;
                fullscreenCallback = callback;
                web.setVisibility(View.GONE);
                root.addView(view, matchParent());
                hideSystemBars();
            }
            @Override public void onHideCustomView() { leaveFullscreen(); }
        });
        root.addView(web, 0, matchParent());
        web.setVisibility(View.VISIBLE);
        // WebView timers are process-wide. A previous Activity may have paused
        // them before this replacement view was created after onResume.
        if (stopped) {
            web.onPause();
            MainActivity visible = visibleActivity.get();
            if (visible == null || visible == this) web.pauseTimers();
        } else {
            web.resumeTimers();
            web.onResume();
        }
    }

    private boolean isLocal(String value) {
        if (origin == null || value == null || value.length() > 8192) return false;
        try {
            URI uri = new URI(value);
            URI base = new URI(origin);
            return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
                    && uri.getPort() == base.getPort() && uri.getUserInfo() == null;
        } catch (Exception invalid) { return false; }
    }

    private boolean supportsPip() {
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private void queryPipState(boolean entering) {
        if (web == null || !isLocal(web.getUrl()) || stopped || isFinishing() || isDestroyed() || !supportsPip()) return;
        if (pipQueryPending && !entering) return;
        pipQueryPending = true;
        final WebView current = web;
        current.evaluateJavascript("JSON.stringify(typeof window.charliflixAndroidState==='function'?window.charliflixAndroidState():null)", result -> {
            pipQueryPending = false;
            if (web != current || stopped || isFinishing() || isDestroyed()) return;
            pipState = PipPlaybackState.parse(result);
            updatePipParams();
            // Android 12+ handles Home/gesture entry from the published params.
            if (entering && Build.VERSION.SDK_INT < 31) enterPip();
        });
    }

    private Rect pipSourceRect() {
        Rect bounds = new Rect();
        if (fullscreen != null && fullscreen.getGlobalVisibleRect(bounds)) return bounds;
        if (web == null || !web.getGlobalVisibleRect(bounds) || !pipState.eligible) return bounds;
        double scaleX = web.getWidth() / pipState.viewportWidth;
        double scaleY = web.getHeight() / pipState.viewportHeight;
        Rect source = new Rect(bounds.left + (int) Math.round(pipState.x * scaleX),
                bounds.top + (int) Math.round(pipState.y * scaleY),
                bounds.left + (int) Math.round((pipState.x + pipState.width) * scaleX),
                bounds.top + (int) Math.round((pipState.y + pipState.height) * scaleY));
        if (!source.intersect(bounds)) return bounds;
        // Match object-fit:contain, excluding letterboxing from the source hint.
        float ratio = pipState.aspectRatio.floatValue();
        int width = Math.min(source.width(), Math.round(source.height() * ratio));
        int height = Math.min(source.height(), Math.round(source.width() / ratio));
        return new Rect(source.centerX() - width / 2, source.centerY() - height / 2,
                source.centerX() + (width + 1) / 2, source.centerY() + (height + 1) / 2);
    }

    private PictureInPictureParams buildPipParams() {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(pipState.aspectRatio);
        Rect source = pipSourceRect();
        if (!source.isEmpty()) builder.setSourceRectHint(source);
        Intent intent = new Intent(this, PipActionReceiver.class).setAction(PipActionReceiver.TOGGLE);
        PendingIntent toggle = PendingIntent.getBroadcast(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = pipState.playing ? "Pause" : "Play";
        int icon = pipState.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        builder.setActions(java.util.Collections.singletonList(new RemoteAction(Icon.createWithResource(this, icon), title, title, toggle)));
        if (Build.VERSION.SDK_INT >= 31) builder.setAutoEnterEnabled(pipEligible).setSeamlessResizeEnabled(true);
        return builder.build();
    }

    private void updatePipParams() {
        if (!supportsPip() || stopped || isFinishing() || isDestroyed()) return;
        pipEligible = pipState.eligible;
        String signature = pipEligible + ":" + pipState.playing + ":" + pipState.aspectRatio + ":" + pipSourceRect().toShortString();
        if (signature.equals(pipSignature)) return;
        try {
            setPictureInPictureParams(buildPipParams());
            pipSignature = signature;
        } catch (IllegalArgumentException | IllegalStateException unavailable) { pipEligible = false; }
    }

    private void enterPip() {
        if (!pipEligible || stopped || isInPictureInPictureMode() || pipRequestPending || isFinishing() || isDestroyed()) return;
        pipRequestPending = true;
        try {
            if (!enterPictureInPictureMode(buildPipParams())) pipRequestPending = false;
        } catch (IllegalArgumentException | IllegalStateException unavailable) { pipRequestPending = false; }
    }

    @Override protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        queryPipState(true);
    }

    private void setPipLayout(boolean enabled) {
        if (web != null && isLocal(web.getUrl())) web.evaluateJavascript(
                "if(typeof window.charliflixSetPictureInPicture==='function')window.charliflixSetPictureInPicture(" + enabled + ")", null);
    }

    @Override public void onPictureInPictureModeChanged(boolean inPictureInPicture, Configuration configuration) {
        super.onPictureInPictureModeChanged(inPictureInPicture, configuration);
        pipRequestPending = false;
        setPipLayout(inPictureInPicture);
        if (inPictureInPicture && web != null) { web.resumeTimers(); web.onResume(); }
        queryPipState(false);
    }

    void togglePipPlayback() {
        if (!isInPictureInPictureMode() || web == null || !isLocal(web.getUrl())) return;
        web.evaluateJavascript("document.getElementById('play-toggle')?.click()", result -> queryPipState(false));
    }

    private static boolean isArchiveVideo(String value) {
        if (value == null || value.length() > 8192) return false;
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getFragment() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
            String host = uri.getHost();
            String path = uri.getPath();
            if (host == null || path == null || !path.toLowerCase(java.util.Locale.ROOT).endsWith(".mp4")) return false;
            return (host.equals("archive.org") && path.startsWith("/download/"))
                    || host.endsWith(".us.archive.org");
        } catch (Exception invalid) { return false; }
    }

    private static boolean isExternalLink(String value) {
        if (value == null || value.length() > 2048) return false;
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
            String path = uri.getPath();
            if ("spelunkr.tv".equals(uri.getHost())) return path.isEmpty() || path.equals("/");
            if ("epgtalk.com".equals(uri.getHost())) return "/api.html".equals(path);
            if (!"github.com".equals(uri.getHost())) return false;
            return "/charlesmbeckwith/charliflix/releases/latest".equals(path)
                    || path.matches("/charlesmbeckwith/charliflix/releases/tag/v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)");
        } catch (Exception invalid) { return false; }
    }

    private void openExternal(String value) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException unavailable) {
            Toast.makeText(this, "Install a browser to open this link.", Toast.LENGTH_SHORT).show();
        }
    }

    private static WebResourceResponse blocked() {
        byte[] empty = new byte[0];
        return new WebResourceResponse("text/plain", StandardCharsets.UTF_8.name(), 403, "Blocked", java.util.Collections.emptyMap(), new ByteArrayInputStream(empty));
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @SuppressWarnings("deprecation")
    private void leaveFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        if (web != null) web.setVisibility(View.VISIBLE);
        WebChromeClient.CustomViewCallback callback = fullscreenCallback;
        fullscreenCallback = null;
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (callback != null) callback.onCustomViewHidden();
    }

    @Override public void onBackPressed() { handleBack(); }

    private void handleBack() {
        if (fullscreen != null) { leaveFullscreen(); return; }
        if (web == null || origin == null) { super.onBackPressed(); return; }
        if (backing) return;
        backing = true;
        web.evaluateJavascript("(typeof window.charliflixBack==='function'&&window.charliflixBack())", result -> {
            backing = false;
            if (!"true".equals(result) && !isFinishing() && !isDestroyed()) {
                pipState = PipPlaybackState.IDLE; updatePipParams();
                MainActivity.super.onBackPressed();
            }
        });
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int source = event.getSource();
        boolean controller = (source & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                || (source & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
        if (controller && web != null) {
            int mapped;
            switch (event.getKeyCode()) {
                case KeyEvent.KEYCODE_BUTTON_B:
                    if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) handleBack();
                    return true;
                case KeyEvent.KEYCODE_BUTTON_A: mapped = KeyEvent.KEYCODE_ENTER; break;
                case KeyEvent.KEYCODE_BUTTON_X: mapped = KeyEvent.KEYCODE_M; break;
                case KeyEvent.KEYCODE_BUTTON_Y: mapped = KeyEvent.KEYCODE_G; break;
                case KeyEvent.KEYCODE_BUTTON_START: mapped = KeyEvent.KEYCODE_T; break;
                case KeyEvent.KEYCODE_BUTTON_L1: mapped = KeyEvent.KEYCODE_PAGE_UP; break;
                case KeyEvent.KEYCODE_BUTTON_R1: mapped = KeyEvent.KEYCODE_PAGE_DOWN; break;
                default: return super.dispatchKeyEvent(event);
            }
            KeyEvent translated = new KeyEvent(event.getDownTime(), event.getEventTime(), event.getAction(), mapped,
                    event.getRepeatCount(), 0, event.getDeviceId(), event.getScanCode(), event.getFlags(), InputDevice.SOURCE_KEYBOARD);
            web.dispatchKeyEvent(translated);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override protected void onPause() {
        paused = true;
        // PiP activities are paused while still visible. Suspension belongs to
        // onStop, which also covers dismissal of the floating player.
        super.onPause();
    }

    @Override protected void onStop() {
        pipState = PipPlaybackState.IDLE;
        updatePipParams();
        stopped = true;
        main.removeCallbacks(pipPoll);
        pipRequestPending = false;
        if (web != null) {
            web.evaluateJavascript("if(typeof window.charliflixSuspend==='function')window.charliflixSuspend();else document.querySelectorAll('video,audio').forEach(media=>media.pause())", null);
            // Timers are shared by every WebView in this process. A closing
            // Activity may stop after its replacement has already started.
            MainActivity visible = visibleActivity.get();
            if (visible == null || visible == this) web.pauseTimers();
            web.onPause();
        }
        if (visibleActivity.get() == this) visibleActivity.clear();
        super.onStop();
    }

    @Override protected void onStart() {
        super.onStart();
        stopped = false;
        visibleActivity = new WeakReference<>(this);
        if (web != null) { web.resumeTimers(); web.onResume(); }
        main.removeCallbacks(pipPoll);
        main.post(pipPoll);
    }

    @Override protected void onResume() {
        super.onResume();
        paused = false;
        if (web != null) {
            web.resumeTimers();
            web.onResume();
        }
        queryPipState(false);
    }

    @Override protected void onDestroy() {
        BackendRuntime.get().detach(this);
        PipActionReceiver.detach(this);
        main.removeCallbacks(pipPoll);
        leaveFullscreen();
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
