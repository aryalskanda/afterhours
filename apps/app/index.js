// The polyfills load before anything else: noble needs crypto.getRandomValues, which React
// Native doesn't have, and zod must be told not to generate code (Hermes can't).
import './src/polyfills'
import 'expo-router/entry'
