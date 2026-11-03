package com.sunpride.chat

import androidx.core.content.FileProvider

/** Its own provider class so it can sit beside the app's update FileProvider in one manifest. */
class ChatFileProvider : FileProvider()
