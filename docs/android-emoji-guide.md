# Android Emoji Implementation Guide

## Option 1: EmojiCompat + Emoji Picker (recommended)

Use this when you want modern emoji support on old Android versions.

### Gradle dependencies

```groovy
dependencies {
    implementation "androidx.emoji2:emoji2:1.5.0"
    implementation "androidx.emoji2:emoji2-views:1.5.0"
    implementation "androidx.emoji2:emojipicker:1.5.0"
}
```

### App initialization

```kotlin
import android.app.Application
import androidx.emoji2.text.EmojiCompat
import androidx.emoji2.text.FontRequestEmojiCompatConfig
import androidx.core.provider.FontRequest

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        val request = FontRequest(
            "com.google.android.gms.fonts",
            "com.google.android.gms",
            "Noto Color Emoji Compat",
            R.array.com_google_android_gms_fonts_certs
        )
        EmojiCompat.init(FontRequestEmojiCompatConfig(this, request))
    }
}
```

### XML views

Use emoji-aware views:

```xml
<androidx.emoji2.widget.EmojiEditText
    android:id="@+id/messageInput"
    android:layout_width="0dp"
    android:layout_height="wrap_content"
    android:layout_weight="1"
    android:hint="Type a message" />
```

### Picker usage

```kotlin
emojiPickerView.setOnEmojiPickedListener { emoji ->
    messageInput.append(emoji.emoji)
}
```

## Option 2: vanniktech/emoji (consistent style packs)

Use this if you need iOS/Twitter/Facebook visual style consistency.

### Gradle dependency

```groovy
dependencies {
    implementation("com.vanniktech:emoji-ios:0.24.1")
}
```

### Initialization

```kotlin
import com.vanniktech.emoji.EmojiManager
import com.vanniktech.emoji.ios.IosEmojiProvider

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        EmojiManager.install(IosEmojiProvider())
    }
}
```

## UI/UX behavior to match web app

- Open emoji panel above input.
- Close panel when:
  - user selects emoji
  - user taps send
  - user taps/focuses message input
- Keep chat list visible and do not let panel hide messages unexpectedly.
