import { useEffect } from 'react'
import { useAudio } from './audio/useAudio'
import { Visualizer } from './visualizers/Visualizer'
import './App.css'

const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 480

/**
 * Background color for the visualizer page.
 * Change this to customize your submission's background.
 */
const BACKGROUND_COLOR = '#0d1f12'

// Module-level constants — stable references, never recreated on render
const ANALYSER_OPTIONS: AnalyserOptions = {
  fftSize: 2048,
  smoothingTimeConstant: 0.6,
  minDecibels: -90,
  maxDecibels: -20,
}
const AUDIO_OPTIONS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
}

function App() {
  const { frequencyData, timeDomainData, isActive, start } = useAudio({
    analyser: ANALYSER_OPTIONS,
    audio: AUDIO_OPTIONS,
  })

  useEffect(() => {
    start()
  }, [start])

  return (
    <div className="app" style={{ backgroundColor: BACKGROUND_COLOR }}>
      <div className="visualizer-container" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}>
        <Visualizer
          frequencyData={frequencyData}
          timeDomainData={timeDomainData}
          isActive={isActive}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
        />
      </div>
    </div>
  )
}

export default App
