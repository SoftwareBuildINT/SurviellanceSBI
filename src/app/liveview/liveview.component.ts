import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import Hls from 'hls.js';
import * as dashjs from 'dashjs';
import html2canvas from 'html2canvas';


@Component({
  selector: 'app-liveview',
  templateUrl: './liveview.component.html',
  styleUrls: ['./liveview.component.scss']
})
export class LiveviewComponent implements OnInit, OnDestroy {
  atmId: string = '';
  siteName: string = '';
  searchTerm: string = '';
  atmList: string[] = [];
  filteredAtmList: string[] = [];
  videoUrls: string[] = ['', '', '', ''];
  snapshotImages: string[] = ['', '', '', ''];
  refreshIntervals: any[] = [null, null, null, null];
  isVideoPlaying: boolean[] = [false, false, false, false];
  vendorId: number = 0;

  showErrorModal: boolean = false;
  errorMessage: string = '';
  lhoId: string = '';
  retryCounts: number[] = [0, 0, 0, 0];
  cameraStates: ('idle' | 'loading' | 'playing' | 'error' | 'unavailable')[] =
    ['idle', 'idle', 'idle', 'idle'];
  cameraMessages: string[] = [
    'Waiting for stream details...',
    'Waiting for stream details...',
    'Waiting for stream details...',
    'Waiting for stream details...'
  ];
  private hlsPlayers: (Hls | null)[] = [null, null, null, null];
  private readonly maxStreamRetries = 12;
  isLoadingStream: boolean = false;
  isCachedData: boolean = false;
  loadTime: number = 0;

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private http: HttpClient,
  ) { }

  ngOnInit(): void {
    this.fetchAtmList();
    this.route.queryParams.subscribe(params => {
      this.atmId = params['atmId'];
      this.siteName = params['siteName'];
      this.lhoId = params['lho_id'];

      if (this.atmId) {
        this.loadVideoStream();
      } else {
        console.log("ATM ID not found");
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyAllPlayers();
  }

  // Fetch the ATM list for autocomplete suggestions
  fetchAtmList(): void {
    this.http.get<{ atm_list: string[] }>(`${environment.apiUrl}atm-list`)
      .subscribe({
        next: (response) => {
          // console.log('ATM list:', response);
          this.atmList = response.atm_list;
        },
        error: (error) => {
          console.error('Error fetching ATM list:', error);
        }
      });
  }

  filterAtmList(): void {
    if (this.searchTerm) {
      this.filteredAtmList = this.atmList.filter(atm =>
        atm.toLowerCase().includes(this.searchTerm.toLowerCase())
      );
      // Check if no ATM IDs match the search term
      if (this.filteredAtmList.length === 0) {
        this.filteredAtmList = ["No Record Found"]
      }
    } else {
      this.filteredAtmList = [];
    }
  }

  selectAtm(atmId: string) {
    this.searchTerm = atmId;
    this.router.navigate(['/liveview'], { queryParams: { atmId: atmId } }).then(() => {
      window.location.reload();
    });
  }

  loadVideoStream(): void {
    const apiUrl = `${environment.apiUrl}live-view-links?atmId=${this.atmId}`;
    const headers = new HttpHeaders({ 'Content-Type': 'application/json' });
    const startTime = Date.now();
    this.isLoadingStream = true;
    this.cameraStates = ['loading', 'loading', 'loading', 'loading'];
    this.cameraMessages = Array(4).fill('Requesting live stream...');

    this.http.post(apiUrl, { headers }).subscribe({
      next: (response: any) => {
        this.loadTime = Date.now() - startTime;
        this.isLoadingStream = false;
        this.isCachedData = response.vendorId !== 3 && this.loadTime < 500;

        console.log('Live view details received:', {
          vendorId: response.vendorId,
          siteName: response.siteName,
          snapshotCount: response.vendorId === 3
            ? [response.camera_1, response.camera_2, response.camera_3, response.camera_4].filter(Boolean).length
            : undefined
        });
        this.vendorId = response.vendorId;
        this.siteName = response.siteName;
        this.snapshotImages = ['', '', '', ''];

        if (response.liveViewLink) {
          // Vendors 2 (ITL) and 5 (DFS) return a single DASH stream URL
          this.videoUrls[0] = response.liveViewLink;
        } else if ((response.vendorId == 1) || (response.vendorId == 4) || (response.vendorId == 6)) {
          // Vendors 1 (Aniket) and 6 (Global) convert RTSP via FFmpeg to local HLS.
          // Vendor 4 (BUILDINT) pushes HLS segments directly to the server.
          this.videoUrls[0] = `${environment.apiUrl}streams/${this.atmId}/camera_1/output.m3u8`;
          this.videoUrls[1] = `${environment.apiUrl}streams/${this.atmId}/camera_2/output.m3u8`;
          this.videoUrls[2] = `${environment.apiUrl}streams/${this.atmId}/camera_3/output.m3u8`;
          this.videoUrls[3] = `${environment.apiUrl}streams/${this.atmId}/camera_4/output.m3u8`;
        }
        else {
          if (response.vendorId === 3) {
            this.snapshotImages = [response.camera_1, response.camera_2, response.camera_3, response.camera_4]
              .map(value => typeof value === 'string' ? value : '');
            this.videoUrls = ['', '', '', ''];
          } else {
            this.videoUrls[0] = response.camera_1;
            this.videoUrls[1] = response.camera_2;
            this.videoUrls[2] = response.camera_3;
            this.videoUrls[3] = response.camera_4;
          }

          // CTS HLS files require Basic Auth at the vendor server. Never expose
          // those credentials in the browser; fetch manifests and segments via
          // our authenticated backend proxy, which applies CTS credentials.
          if (response.vendorId === 7) {
            this.videoUrls = this.videoUrls.map(url => url
              ? `${environment.apiUrl}proxy-hls?url=${encodeURIComponent(url)}`
              : ''
            );
          }
        }

        // Initialize streams for each camera
        this.videoUrls.forEach((url, index) => {
          if (this.vendorId === 3) {
            if (this.snapshotImages[index]) {
              this.cameraStates[index] = 'playing';
              this.cameraMessages[index] = '';
            } else {
              this.cameraStates[index] = 'unavailable';
              this.cameraMessages[index] = 'No snapshot was returned for this camera.';
            }
            return;
          }
          if (url) {
            this.cameraStates[index] = 'loading';
            this.cameraMessages[index] = this.vendorId === 7
              ? 'CTS is generating the live stream...'
              : 'Connecting to camera...';
            this.initStream(index);
          } else {
            this.cameraStates[index] = 'unavailable';
            this.cameraMessages[index] = 'Camera stream is not configured.';
          }
        });
      },
      error: (error) => {
        this.isLoadingStream = false;
        this.cameraStates = ['error', 'error', 'error', 'error'];
        const status = Number(error.status || error.error?.status || 0);
        const message = status === 404
          ? 'Vendor stream details were not found.'
          : status === 401 || status === 403
            ? 'Live stream authorization failed.'
            : status >= 500
              ? 'Vendor live-stream service is unavailable.'
              : 'Unable to obtain camera details.';
        this.cameraMessages = Array(4).fill(message);
        console.error('Error fetching stream data:', error.error?.message || error.message);
        this.showErrorModal = true;
        this.errorMessage = `${message} Please contact the vendor or try again later.`;
      },
      complete: () => {
        console.log('Stream data fetch complete.');
      }
    });
  }

  refreshStream(): void {
    this.destroyAllPlayers();
    this.isVideoPlaying = [false, false, false, false];
    this.retryCounts = [0, 0, 0, 0];
    this.videoUrls = ['', '', '', ''];
    this.snapshotImages = ['', '', '', ''];

    this.refreshIntervals.forEach(interval => {
      if (interval) clearInterval(interval);
    });
    this.refreshIntervals = [null, null, null, null];

    this.loadVideoStream();
  }

  initStream(index: number): void {
    const videoElement = document.getElementById(`video_camera_${index + 1}`) as HTMLVideoElement;
    this.isVideoPlaying[index] = false;

    if (this.vendorId === 2 || this.vendorId === 5) {
      this.initDashStream(videoElement, index);
    } else {
      this.initHlsStream(videoElement, index);
    }
  }

  initHlsStream(videoElement: HTMLVideoElement, index: number): void {
    if (Hls.isSupported()) {
      this.destroyPlayer(index);
      const hls = new Hls({
        xhrSetup: (xhr: XMLHttpRequest, url: string) => {
          // Angular interceptors do not run for HLS.js requests. Attach the
          // Dashboard JWT only to our own API requests (local streams/proxy),
          // never to third-party vendor hosts.
          try {
            const requestUrl = new URL(url, window.location.origin);
            if (requestUrl.hostname === window.location.hostname && requestUrl.pathname.includes('/api/')) {
              const token = localStorage.getItem('token');
              if (token) {
                // HLS.js calls xhrSetup before opening the XHR. Open it here so
                // setRequestHeader is valid and the JWT is actually transmitted.
                if (xhr.readyState === XMLHttpRequest.UNSENT) xhr.open('GET', url, true);
                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
              }
            }
          } catch (_) { /* HLS.js will surface malformed URL errors normally */ }
        }
      });
      this.hlsPlayers[index] = hls;
      hls.loadSource(this.videoUrls[index]);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.cameraMessages[index] = 'Starting live video...';
        videoElement.muted = true;
        videoElement.play().then(() => {
          this.isVideoPlaying[index] = true;
          this.cameraStates[index] = 'playing';
          this.cameraMessages[index] = '';
          this.resetRetryCount(index);
        }).catch((error) => {
          console.error(`Video play error for camera ${index + 1}:`, error);
        });
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error(`HLS.js error for camera ${index + 1}:`, data);
        if (data.fatal) {
          this.cameraMessages[index] = this.streamErrorMessage(data);
          this.handleRetry(() => this.initHlsStream(videoElement, index), index);
        }
      });
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = this.videoUrls[index];
      videoElement.muted = true;
      videoElement.play().then(() => {
        this.isVideoPlaying[index] = true;
        this.cameraStates[index] = 'playing';
        this.cameraMessages[index] = '';
        this.resetRetryCount(index);
      }).catch((error) => {
        console.error(`Video play error for camera ${index + 1}:`, error);
        this.handleRetry(() => this.initHlsStream(videoElement, index), index);
      });
    }
  }

  initDashStream(videoElement: HTMLVideoElement, index: number): void {
    const player = dashjs.MediaPlayer().create();
    player.initialize(videoElement, this.videoUrls[index], true);

    player.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, () => {
      console.log(`Dash.js playback started for camera ${index + 1}`);
      this.isVideoPlaying[index] = true;
      this.resetRetryCount(index);
      videoElement.muted = true;
    });

    player.on(dashjs.MediaPlayer.events.ERROR, (error) => {
      console.error(`Dash.js error for camera ${index + 1}:`, error);
      this.handleRetry(() => this.initDashStream(videoElement, index), index);
    });
  }

  handleRetry(retryFunction: () => void, index: number): void {
    if (this.refreshIntervals[index]) return;

    this.retryCounts[index]++;
    if (this.retryCounts[index] > this.maxStreamRetries) {
      this.destroyPlayer(index);
      this.cameraStates[index] = 'error';
      this.cameraMessages[index] = this.vendorId === 7
        ? 'Vendor stream is unavailable. Please contact the vendor.'
        : 'Vendor camera stream is unavailable or could not be converted to HLS.';
    } else {
      console.log(`Retry attempt ${this.retryCounts[index]} for camera ${index + 1}`);
      this.cameraStates[index] = 'loading';
      this.cameraMessages[index] = this.vendorId === 7
        ? `CTS is generating the stream. Retrying automatically (${this.retryCounts[index]}/${this.maxStreamRetries})...`
        : `Connecting to camera. Retrying (${this.retryCounts[index]}/${this.maxStreamRetries})...`;
      this.destroyPlayer(index);
      this.refreshIntervals[index] = setTimeout(() => {
        this.refreshIntervals[index] = null;
        retryFunction();
      }, 5000);
    }
  }

  private streamErrorMessage(data: any): string {
    const status = Number(data?.response?.code || data?.response?.status || 0);
    if (status === 404) return 'Vendor stream is unavailable (HLS stream not found).';
    if (status === 401 || status === 403) return 'Stream authorization failed.';
    if (status === 502 || status === 503 || status === 504) return 'Vendor camera service is unreachable.';
    return this.vendorId === 7
      ? 'Vendor is generating the stream. Please wait...'
      : 'Connecting to vendor camera stream...';
  }

  retryCamera(index: number): void {
    this.retryCounts[index] = 0;
    this.cameraStates[index] = 'loading';
    this.cameraMessages[index] = 'Requesting a fresh live stream...';

    // CTS URLs are temporary, so request a fresh set for the ATM. For other
    // vendors, retry only the selected camera URL.
    if (this.vendorId === 7) {
      this.refreshStream();
      return;
    }
    this.initStream(index);
  }

  private destroyPlayer(index: number): void {
    if (this.hlsPlayers[index]) {
      this.hlsPlayers[index]!.destroy();
      this.hlsPlayers[index] = null;
    }
  }

  private destroyAllPlayers(): void {
    this.hlsPlayers.forEach((_, index) => this.destroyPlayer(index));
    this.refreshIntervals.forEach(timer => {
      if (timer) clearTimeout(timer);
    });
    this.refreshIntervals = [null, null, null, null];
  }

  downloadScreenshot() {
    const element = document.querySelector('.live-view') as HTMLElement;

    if (!element) {
      console.error('Screenshot area not found!');
      return;
    }

    html2canvas(element, { scale: 2 }).then(canvas => {
      const link = document.createElement('a');
      link.download = `liveview_${this.atmId}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
  }

  resetRetryCount(index: number): void {
    this.retryCounts[index] = 0;
    if (this.refreshIntervals[index]) {
      clearInterval(this.refreshIntervals[index]);
      this.refreshIntervals[index] = null;
    }
  }

  closeErrorModal(): void {
    this.showErrorModal = false;
  }

  goBack(): void {
    this.router.navigate(['/dashboard']);
  }
}
