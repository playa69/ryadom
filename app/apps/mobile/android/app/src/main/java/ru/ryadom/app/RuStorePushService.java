package ru.ryadom.app;

import android.util.Log;
import java.util.List;
import ru.rustore.sdk.pushclient.messaging.exception.RuStorePushClientException;
import ru.rustore.sdk.pushclient.messaging.model.RemoteMessage;
import ru.rustore.sdk.pushclient.messaging.service.RuStoreMessagingService;

/**
 * What the RuStore SDK tells the app. A message with a title and text is shown by the SDK itself, and its data reach
 * the app with the tap (`RuStorePushPlugin`), so a received message needs nothing here. A new token goes to the plugin:
 * the web part subscribes again with it.
 */
public class RuStorePushService extends RuStoreMessagingService {

    private static final String TAG = "RuStorePush";

    @Override
    public void onNewToken(String token) {
        RuStorePushPlugin.onNewToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        // Shown by the SDK from its `notification` part.
    }

    @Override
    public void onError(List<? extends RuStorePushClientException> errors) {
        // No RuStore, no background permission for it, a user not signed in to it: pushes are late or absent, the app
        // goes on. The token request reports the same to the person when they switch notifications on.
        for (RuStorePushClientException error : errors) {
            Log.w(TAG, "RuStore Push SDK error: " + error.getClass().getSimpleName());
        }
    }
}
