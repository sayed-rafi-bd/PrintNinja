package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Framework-free contract tests: the action strings and channel ids
 * are the integration surface (MainActivity patch, notification taps,
 * the Stop action). Renaming one silently breaks the handoff, so the
 * names are pinned here where plain JUnit can reach them.
 */
class ServiceContractTest {

    @Test
    fun stopActionIsNamespacedToThePlugin() {
        assertEquals(
            "com.printninja.android_print.STOP_SERVICE",
            PrintNinjaService.ACTION_STOP,
        )
    }

    @Test
    fun channelAndNotificationIdsAreStable() {
        assertEquals("printninja-print-service", PrintNinjaService.CHANNEL_ID)
        assertEquals(1, PrintNinjaService.NOTIFICATION_ID)
    }

    @Test
    fun stopActionIsDistinctFromLifecycleActions() {
        assertTrue(PrintNinjaService.ACTION_STOP.startsWith("com.printninja."))
    }
}
