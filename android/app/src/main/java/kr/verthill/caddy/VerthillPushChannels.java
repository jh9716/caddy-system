package kr.verthill.caddy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * Lockscreen PRIVATE channel. Existing id "verthill" was PUBLIC and cannot
 * be mutated in place, so create verthill-private then delete the leftover.
 */
final class VerthillPushChannels {

    static final String CHANNEL_ID = "verthill-private";
    static final String CHANNEL_ID_LEGACY = "verthill";
    static final String CHANNEL_NAME = "VERTHILL";
    static final int IMPORTANCE = NotificationManager.IMPORTANCE_HIGH;
    static final int VISIBILITY = Notification.VISIBILITY_PRIVATE;

    private VerthillPushChannels() {}

    static void ensurePrivateChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (context == null) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, IMPORTANCE);
        channel.setLockscreenVisibility(VISIBILITY);
        manager.createNotificationChannel(channel);
        manager.deleteNotificationChannel(CHANNEL_ID_LEGACY);
    }
}
