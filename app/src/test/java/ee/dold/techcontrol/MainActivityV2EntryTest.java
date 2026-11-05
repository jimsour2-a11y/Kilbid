package ee.dold.techcontrol;

import android.content.Intent;
import android.os.Looper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class MainActivityV2EntryTest {
    @Test public void existingV1ActivityOpensSeparateV2ScreenAndReturns() {
        MainActivity main = Robolectric.buildActivity(MainActivity.class).create().start().resume().get();
        main.new AndroidBridge().openV2Test();
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        Intent launched = Shadows.shadowOf(main).getNextStartedActivity();
        assertNotNull(launched);
        assertEquals(V2TestActivity.class.getName(), launched.getComponent().getClassName());
        main.finish();
    }
}
