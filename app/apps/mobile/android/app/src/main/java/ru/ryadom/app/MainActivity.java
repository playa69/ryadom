package ru.ryadom.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins are not found by `cap sync`: they are registered before the bridge starts.
        registerPlugin(RuStorePushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
