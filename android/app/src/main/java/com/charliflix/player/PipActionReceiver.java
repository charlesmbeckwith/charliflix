package com.charliflix.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.lang.ref.WeakReference;

/** Explicit, immutable PendingIntent target; not exported to other applications. */
public final class PipActionReceiver extends BroadcastReceiver {
    static final String TOGGLE = "com.charliflix.player.PIP_TOGGLE";
    private static WeakReference<MainActivity> activity = new WeakReference<>(null);

    static void attach(MainActivity owner) { activity = new WeakReference<>(owner); }
    static void detach(MainActivity owner) { if (activity.get() == owner) activity.clear(); }

    @Override public void onReceive(Context context, Intent intent) {
        MainActivity owner = activity.get();
        if (owner != null && TOGGLE.equals(intent.getAction())) owner.togglePipPlayback();
    }
}
