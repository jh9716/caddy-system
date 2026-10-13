/**
 * Android notification channel privacy.
 *
 * Lockscreen visibility cannot be changed on an existing NotificationChannel.
 * Existing installs created id "verthill" with PUBLIC (1). A new channel id
 * plus delete of the leftover PUBLIC channel is the only way those devices
 * actually become PRIVATE. Importance stays HIGH so sound/heads-up remain.
 *
 * Native Application.onCreate also ensures this channel so FCM can post
 * before the WebView JS bridge runs.
 */
export const NATIVE_PUSH_CHANNEL_ID = "verthill-private";
export const NATIVE_PUSH_CHANNEL_ID_LEGACY = "verthill";
export const NATIVE_PUSH_CHANNEL_NAME = "VERTHILL";
/** NotificationManager.IMPORTANCE_HIGH */
export const NATIVE_PUSH_CHANNEL_IMPORTANCE = 4;
/** NotificationCompat.VISIBILITY_PRIVATE */
export const NATIVE_PUSH_CHANNEL_VISIBILITY_PRIVATE = 0;

export type NativePushChannelCreateSpec = {
  id: typeof NATIVE_PUSH_CHANNEL_ID;
  name: typeof NATIVE_PUSH_CHANNEL_NAME;
  importance: typeof NATIVE_PUSH_CHANNEL_IMPORTANCE;
  visibility: typeof NATIVE_PUSH_CHANNEL_VISIBILITY_PRIVATE;
};

export function nativePushChannelCreateSpec(): NativePushChannelCreateSpec {
  return {
    id: NATIVE_PUSH_CHANNEL_ID,
    name: NATIVE_PUSH_CHANNEL_NAME,
    importance: NATIVE_PUSH_CHANNEL_IMPORTANCE,
    visibility: NATIVE_PUSH_CHANNEL_VISIBILITY_PRIVATE,
  };
}

/**
 * Create the PRIVATE channel first. Only then drop the leftover PUBLIC id
 * so a create failure cannot leave the device with no channel.
 */
export async function migrateNativePushPrivacyChannel(ops: {
  createChannel: (channel: NativePushChannelCreateSpec) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;
}): Promise<void> {
  await ops.createChannel(nativePushChannelCreateSpec());
  await ops.deleteChannel(NATIVE_PUSH_CHANNEL_ID_LEGACY);
}
