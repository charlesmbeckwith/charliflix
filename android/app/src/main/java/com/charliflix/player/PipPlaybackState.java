package com.charliflix.player;

import android.util.Rational;

import org.json.JSONObject;
import org.json.JSONTokener;

/** Bounded, data-only snapshot returned by the owned player document. */
final class PipPlaybackState {
    static final PipPlaybackState IDLE = new PipPlaybackState(false, false, new Rational(16, 9), 0, 0, 0, 0, 0, 0);
    final boolean eligible;
    final boolean playing;
    final Rational aspectRatio;
    final double x, y, width, height, viewportWidth, viewportHeight;

    private PipPlaybackState(boolean eligible, boolean playing, Rational aspectRatio, double x, double y, double width,
                             double height, double viewportWidth, double viewportHeight) {
        this.eligible = eligible;
        this.playing = playing;
        this.aspectRatio = aspectRatio;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.viewportWidth = viewportWidth;
        this.viewportHeight = viewportHeight;
    }

    static PipPlaybackState parse(String result) {
        if (result == null || result.length() > 8192) return IDLE;
        try {
            Object decoded = new JSONTokener(result).nextValue();
            if (!(decoded instanceof String)) return IDLE;
            JSONObject data = new JSONObject((String) decoded);
            boolean playing = Boolean.TRUE.equals(data.opt("playing"));
            boolean enabled = Boolean.TRUE.equals(data.opt("pictureInPictureEnabled"));
            double videoWidth = number(data, "videoWidth", 1, 16384);
            double videoHeight = number(data, "videoHeight", 1, 16384);
            // Android permits aspect ratios from 1:2.39 through 2.39:1.
            double ratio = videoWidth / videoHeight;
            Rational aspect = ratio > 2.39 ? new Rational(239, 100)
                    : ratio < 1 / 2.39 ? new Rational(100, 239)
                    : new Rational((int) Math.round(videoWidth), (int) Math.round(videoHeight));
            JSONObject rect = data.getJSONObject("rect");
            return new PipPlaybackState(playing && enabled, playing, aspect,
                    number(rect, "x", -16384, 16384), number(rect, "y", -16384, 16384),
                    number(rect, "width", 1, 16384), number(rect, "height", 1, 16384),
                    number(data, "viewportWidth", 1, 16384), number(data, "viewportHeight", 1, 16384));
        } catch (Exception invalid) { return IDLE; }
    }

    private static double number(JSONObject object, String key, double minimum, double maximum) throws Exception {
        Object raw = object.opt(key);
        if (!(raw instanceof Number)) throw new IllegalArgumentException("Invalid PiP geometry");
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value < minimum || value > maximum) throw new IllegalArgumentException("Invalid PiP geometry");
        return value;
    }
}
