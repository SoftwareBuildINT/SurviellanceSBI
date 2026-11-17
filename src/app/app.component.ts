import { Component } from '@angular/core';
import { IdleService } from './services/idle.service';

@Component({
  selector: 'app-root',
  template: '<router-outlet></router-outlet>',
})
export class AppComponent { 

  constructor(private idleService: IdleService) {
    // Service starts automatically
  }
}
