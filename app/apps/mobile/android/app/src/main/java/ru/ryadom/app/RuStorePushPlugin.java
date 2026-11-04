package ru.ryadom.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import ru.rustore.sdk.pushclient.RuStorePushClient;

/**
 * RuStore Push for the web part (`src/client/lib/push.ts`). There is no maintained Capacitor plugin for it, and
 * `@capacitor/push-notifications` goes through Firebase, so this is a thin one over the SDK:
 *
 * - `checkPermission` / `requestPermission`: POST_NOTIFICATIONS on Android 13+, the app's notification switch below;
 * - `getToken`: the push token with the push project of this build and the package, what the server subscribes;
 * - `deleteToken`: on switching off and signing out, so the phone stops being an address;
 * - `openSettings`: the system screen of the app's notifications, for a refusal;
 * - `tokenChanged`: a new token from the SDK, so the web part subscribes again;
 * - `notificationOpened`: the data of a tapped notification. The SDK opens this activity with the data in the extras;
 *   a cold start delivers the event once a listener appears, and the extras are removed once read, so a recreated
 *   activity does not open the screen a second time.
 */
@CapacitorPlugin(
    name = "RuStorePush",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = RuStorePushPlugin.NOTIFICATIONS) }
)
public class RuStorePushPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";
    /** The data keys of a notification the app acts on (`PushDataKey` in the contract); the rest are not read. */
    private static final String[] DATA_KEYS = { "link" };

    /** The plugin of the running bridge, for the SDK's service, which lives apart from it. */
    private static volatile RuStorePushPlugin instance;

    @Override
    public void load() {
        instance = this;
        handleTap(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleTap(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** From the SDK's service, on its background thread; no bridge (the app is not open) means the next start does it. */
    static void onNewToken(String token) {
        RuStorePushPlugin plugin = instance;
        if (plugin == null) return;
        JSObject event = new JSObject();
        event.put("token", token);
        plugin.getBridge().executeOnMainThread(() -> plugin.notifyListeners("tokenChanged", event));
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        call.resolve(receive());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            call.resolve(receive());
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "permissionAnswered");
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        call.resolve(receive());
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        RuStorePushClient.INSTANCE.getToken()
            .addOnSuccessListener(token -> {
                JSObject result = new JSObject();
                result.put("token", token);
                result.put("projectId", getContext().getString(R.string.rustore_push_project_id));
                result.put("appId", getContext().getPackageName());
                call.resolve(result);
            })
            .addOnFailureListener(error -> {
                // By name: a phone with no app to deliver pushes (RuStore or a VK app) and a RuStore that was never
                // opened (the SDK cannot bind to it) are the failures the person can do something about.
                String name = error.getClass().getSimpleName();
                String code = name.contains("NotInstalled") || name.contains("BindingFailed") ? "UNAVAILABLE" : "FAILED";
                call.reject("No push token: " + name, code);
            });
    }

    @PluginMethod
    public void deleteToken(PluginCall call) {
        RuStorePushClient.INSTANCE.deleteToken()
            .addOnSuccessListener(result -> call.resolve())
            .addOnFailureListener(error -> call.reject("Push token not deleted: " + error.getClass().getSimpleName(), "FAILED"));
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String app = getContext().getPackageName();
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, app)
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", app, null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * Granted only when the system will show them: on Android 13+ the permission, and on every version the app's own
     * switch in the settings, which the person can turn off without touching the permission.
     */
    private JSObject receive() {
        String state;
        boolean shown = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            state = shown ? "granted" : "denied";
        } else {
            PermissionState permission = getPermissionState(NOTIFICATIONS);
            if (permission == PermissionState.GRANTED) state = shown ? "granted" : "denied";
            else if (permission == PermissionState.DENIED) state = "denied";
            else state = "prompt";
        }
        JSObject result = new JSObject();
        result.put("receive", state);
        return result;
    }

    private void handleTap(Intent intent) {
        if (intent == null) return;
        Bundle extras = intent.getExtras();
        if (extras == null) return;
        JSObject data = new JSObject();
        for (String key : DATA_KEYS) {
            String value = extras.getString(key);
            if (value == null) continue;
            data.put(key, value);
            intent.removeExtra(key);
        }
        if (data.length() == 0) return;
        JSObject event = new JSObject();
        event.put("data", data);
        notifyListeners("notificationOpened", event, true);
    }
}
