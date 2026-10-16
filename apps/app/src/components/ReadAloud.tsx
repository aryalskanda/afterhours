// Reads text out loud on this device (the system's voice); a second tap stops it.

import * as Speech from 'expo-speech'
import { useEffect, useState } from 'react'
import { speakable } from '../lib/speech'
import { GroupAction } from './ui'

export function ReadAloud(props: { text: string; testID?: string }) {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => () => void Speech.stop(), [])
  return (
    <GroupAction
      title={speaking ? 'Stop' : 'Read aloud'}
      testID={props.testID}
      onPress={async () => {
        if (speaking) {
          await Speech.stop()
          setSpeaking(false)
          return
        }
        setSpeaking(true)
        Speech.speak(speakable(props.text), { onDone: () => setSpeaking(false), onStopped: () => setSpeaking(false), onError: () => setSpeaking(false) })
      }}
    />
  )
}
