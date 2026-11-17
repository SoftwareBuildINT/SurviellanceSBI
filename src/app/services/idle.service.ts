import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

@Injectable({
  providedIn: 'root',
})
export class IdleService {
  private timeout: any;
  private readonly idleTime = 5 * 60 * 1000; // 5 minutes
  private boundResetTimer = this.resetTimer.bind(this);
  private watching = false;

  constructor(private router: Router) {}

  startWatching() {
    if (this.watching) {
      // Already watching — just reset the timer, don't add duplicate listeners
      this.resetTimer();
      return;
    }
    this.watching = true;
    this.resetTimer();

    window.addEventListener('mousemove', this.boundResetTimer);
    window.addEventListener('keydown', this.boundResetTimer);
    window.addEventListener('click', this.boundResetTimer);
  }

  resetTimer() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }

    this.timeout = setTimeout(() => {
      this.logout();
    }, this.idleTime);
  }

  stopWatching() {
    this.watching = false;
    clearTimeout(this.timeout);

    window.removeEventListener('mousemove', this.boundResetTimer);
    window.removeEventListener('keydown', this.boundResetTimer);
    window.removeEventListener('click', this.boundResetTimer);
  }

  logout() {
    this.stopWatching(); // 👈 stop idle watcher
    localStorage.clear();
    this.router.navigate(['/login']);
    alert('You were logged out due to inactivity.');
  }
}
