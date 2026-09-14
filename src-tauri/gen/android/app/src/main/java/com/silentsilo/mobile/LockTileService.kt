package com.silentsilo.mobile

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

// "Lock SilentSilo" in Quick Settings: locks every open silo from any
// screen. Shown active while one is open.
class LockTileService : TileService() {
  override fun onStartListening() {
    refresh()
  }

  override fun onClick() {
    Native.start(applicationContext)
    Native.lockAll()
    refresh()
  }

  private fun refresh() {
    val tile = qsTile ?: return
    Native.start(applicationContext)
    tile.state = if (Native.anyOpen()) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
    tile.updateTile()
  }
}
