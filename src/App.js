/* global fetch, Notification */
import React, { Component } from 'react'
import Stethoscope from './lib/Stethoscope'
import Device from './Device'
import Loader from './Loader'
import openSocket from 'socket.io-client'
import moment from 'moment'
import prettyBytes from './lib/prettyBytes'
import classNames from 'classnames'
import { HOST } from './constants'
import { MAC } from './lib/platform'
import appConfig from './config.json'
import ErrorMessage from './ErrorMessage'
import './App.css'

const socket = openSocket(HOST)

let platform = MAC
let shell, ipcRenderer, log, remote
// CRA doesn't like importing native node modules, have to use window.require AFAICT
try {
  const os = window.require('os')
  shell = window.require('electron').shell
  remote = window.require('electron').remote
  log = remote.getGlobal('log')
  platform = os.platform()
  ipcRenderer = window.require('electron').ipcRenderer
} catch (e) {
  // browser polyfill
  ipcRenderer = { on () {}, send () {} }
  log = console
}

class App extends Component {
  state = {
    device: {},
    policy: {},
    result: {},
    instructions: {},
    scanIsRunning: false,
    loading: false,
    // determines loading screen language
    remoteScan: false,
    // surface which app performed the most recent scan
    scannedBy: 'Stethoscope',
    lastScanTime: Date.now(),
    // whether app currently has focus
    focused: true,
    // progress object from updater process { percent, total, transferred }
    downloadProgress: null,
    // whether rescan button should be highlighted
    highlightRescan: false
  }

  componentWillUnmount () {
    this.setState({ scanIsRunning: false })
  }

  async componentWillMount () {
    ipcRenderer.send('scan:init')
    // perform the initial policy load & scan
    await this.loadPractices()
    // flag ensures the download:start event isn't sent multiple times
    this.downloadStartSent = false
    // handle context menu
    window.addEventListener('contextmenu', () => ipcRenderer.send('contextmenu'))
    // handle App update download progress
    ipcRenderer.on('download:progress', this.onDownloadProgress)
    // handles any errors that occur when updating (restores window size, etc.)
    ipcRenderer.on('download:error', this.onDownloadError)
    // trigger scan from main process
    ipcRenderer.on('autoscan:start', ({ notificationOnViolation = false }) => {
      if (!this.state.scanIsRunning) {
        console.log('autoscan')
        ipcRenderer.send('scan:init')
        if (Object.keys(this.state.policy).length) {
          this.scan()
        } else {
          this.loadPractices()
        }
      }
    })
    // the server emits this event when a remote scan begins
    socket.on('scan:init', this.onScanInit)
    // setup a socket io listener to refresh the app when a scan is performed
    socket.on('scan:complete', this.onScanComplete)
    // the focus/blur handlers are used to update the last scanned time
    window.addEventListener('focus', () => this.setState({ focused: true }))
    window.addEventListener('blur', () => this.setState({ focused: false }))
    document.addEventListener('dragover', event => event.preventDefault())
    document.addEventListener('drop', event => event.preventDefault())
  }

  onDownloadProgress = (event, downloadProgress) => {
    // trigger the app resize first time through
    if (!this.downloadStartSent) {
      ipcRenderer.send('download:start')
      this.downloadStartSent = true
    }

    if (downloadProgress && downloadProgress.percent >= 99) {
      ipcRenderer.send('download:complete')
    } else {
      this.setState({ downloadProgress })
    }
  }

  onDownloadError = (event, error) => {
    ipcRenderer.send('download:complete', { resize: true })
    const msg = `Error downloading app update: ${error}`
    log.error(msg)
    this.setState({
      downloadProgress: null,
      error: msg
    }, () => {
      // reset this so downloading can start again
      this.downloadStartSent = false
    })
  }

  onScanInit = ({ remote, remoteLabel }) => {
    ipcRenderer.send('scan:init')
    this.setState({
      loading: true,
      remoteScan: remote,
      scannedBy: remote ? remoteLabel : 'Stethoscope'
    })
  }

  onScanComplete = payload => {
    const {
      errors = [],
      noResults = false,
      remote: remoteScan,
      remoteLabel,
      result,
      policy: appPolicy,
      showNotification
    } = payload

    // device only scan with no policy completed
    if (noResults) {
      return this.setState({ loading: false, scannedBy: 'Stethoscope' })
    }

    if (errors && errors.length) {
      log.error(JSON.stringify({
        level: 'error',
        message: 'Error scanning',
        policy: appPolicy
      }))

      return this.setState({
        loading: false,
        errors: errors.map(({ message }) => message)
      })
    }

    const { data: { policy = {} } } = Object(result)
    const scannedBy = remote ? remoteLabel : 'Stethoscope'

    let newState = {
      result: policy.validate,
      loading: false,
      remoteScan,
      scannedBy
    }

    if (policy.validate.status !== 'PASS') {
      // perform action on scan violation
    }

    this.setState(newState, () => {
      ipcRenderer.send('app:loaded')
      if (this.state.result.status !== 'PASS' && showNotification) {
        const note = new Notification('Security recommendation', {
          body: 'You can improve the security settings on this device. Click for more information.'
        })
        note.onerror = err => console.error(err)
      }
    })
  }

  handleResponseError = (err = { message: 'Error requesting policy information' }) => {
    log.error('App:response error', err)
    this.setState({ error: err, loading: false })
  }
  /**
   * loads config, policy, and instructions and initializes a scan
   * using them
   */
  loadPractices = () => {
    this.setState({ loading: true }, () => {
      const files = ['config', 'policy', 'instructions']
      const promises = files.map(item =>
        fetch(`${HOST}/${item}`).then(res => res.json()).catch(this.handleResponseError)
      )

      Promise.all(promises).then(([config, policy, instructions]) => {
        this.setState({ config, policy, instructions }, () => {
          log.info(JSON.stringify(this.state.policy))
          if (!this.state.scanIsRunning) {
            this.scan()
          }
        })
      }).catch(this.handleResponseError)
    })
  }
  /**
   * Opens a link in the native default browser
   */
  openExternal = event => {
    event.preventDefault()
    if (event.target.getAttribute('href')) {
      shell.openExternal(event.target.getAttribute('href'))
    }
  }
  /**
   * Performs a scan by passing the current policy to the graphql server
   */
  scan = () => {
    this.setState({ loading: true, scanIsRunning: true }, () => {
      console.log('scanning with policy', this.state.policy)
      Stethoscope.validate(this.state.policy).then(({ device, result }) => {
        const lastScanTime = Date.now()
        this.setState({
          device,
          result,
          lastScanTime,
          scanIsRunning: false,
          scannedBy: 'Stethoscope',
          loading: false
        }, () => {
          ipcRenderer.send('app:loaded')
        })
      }).catch(err => {
        console.log(err)
        log.error(err)
        let message = new Error('Request timeout')
        if (err.errors) {
          message = new Error(JSON.stringify(err.errors))
        }
        this.handleResponseError({ message })
      })
    })
  }

  highlightRescanButton = event => this.setState({ highlightRescan: true })

  render () {
    const {
      device, policy, result, downloadProgress,
      scannedBy, lastScanTime, error,
      instructions, loading, highlightRescan
    } = this.state

    const isDev = process.env.NODE_ENV === 'development'

    let content = null

    // don't want to render entire app, partition device info, etc. if downloading an update
    if (downloadProgress !== null) {
      content = (
        <div className='App'>
          <div id='downloadProgress'>
            <p>Downloading update ({prettyBytes(downloadProgress.transferred)} of {prettyBytes(downloadProgress.total)})</p>
            <progress max='100' value={downloadProgress.percent} />
          </div>
        </div>
      )
    }

    if (error) {
      content = (
        <ErrorMessage
          showStack={isDev}
          message={error.message}
          stack={error.stack}
          config={appConfig}
        />
      )
    }

    if (loading) {
      content = (
        <Loader
          remoteScan={this.state.remoteScan}
          remoteLabel={this.state.scannedBy}
        />
      )
    }

    if (!content) {
      const secInfo = Stethoscope.partitionSecurityInfo(policy, result, device, instructions.practices, platform)
      const decoratedDevice = Object.assign({}, device, secInfo, { lastScanTime })
      const lastScanFriendly = moment(lastScanTime).fromNow()

      content = (
        <div>
          <Device {...decoratedDevice}
            org={instructions.organization}
            scanResult={result}
            strings={instructions.strings}
            policy={policy}
            lastScanTime={lastScanFriendly}
            scannedBy={scannedBy}
            onExpandPolicyViolation={this.highlightRescanButton}
          />
          <footer className='toolbar toolbar-footer'>
            <div className='buttonRow'>
              <button
                className={classNames('btn btn-default', {
                  'btn-primary': highlightRescan && result.status !== 'PASS'
                })}
                onClick={this.scan}
              >
                <span className='icon icon-arrows-ccw' />
                {instructions.strings.rescanButton}
              </button>
              {appConfig.stethoscopeWebURI && (
                <button
                  className='btn pull-right'
                  href={appConfig.stethoscopeWebURI}
                  onClick={this.openExternal}
                >
                  <span className='icon icon-monitor white' />view all devices
                </button>
              )}
            </div>
          </footer>
        </div>
      )
    }

    return (
      <div className={`App ${loading ? 'loading' : ''}`}>
        {content}
      </div>
    )
  }
}

export default App
