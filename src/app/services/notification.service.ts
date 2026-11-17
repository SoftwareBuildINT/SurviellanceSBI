import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface ErrorNotification {
  id: string;
  message: string;
  type: 'error' | 'warning' | 'info' | 'success';
  timeout?: number;
  actions?: { label: string, action: () => void }[];
}

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private notificationsSubject = new BehaviorSubject<ErrorNotification[]>([]);
  public notifications$ = this.notificationsSubject.asObservable();

  constructor() {}

  public showError(message: string, timeout: number = 5000, actions?: { label: string, action: () => void }[]): string {
    return this.addNotification({
      id: this.generateId(),
      message,
      type: 'error',
      timeout,
      actions
    });
  }

  public showSuccess(message: string, timeout: number = 3000): string {
    return this.addNotification({
      id: this.generateId(),
      message,
      type: 'success',
      timeout
    });
  }

  public showWarning(message: string, timeout: number = 4000): string {
    return this.addNotification({
      id: this.generateId(),
      message,
      type: 'warning',
      timeout
    });
  }

  public showInfo(message: string, timeout: number = 4000): string {
    return this.addNotification({
      id: this.generateId(),
      message,
      type: 'info',
      timeout
    });
  }

  public showConnectionError(): string {
    return this.showError(
      'Connection lost. Please check your internet connection.',
      0, // No auto-dismiss
      [
        {
          label: 'Retry',
          action: () => {
            window.location.reload();
          }
        }
      ]
    );
  }

  public showTimeoutError(): string {
    return this.showError(
      'Request timed out. The server is taking too long to respond.',
      8000,
      [
        {
          label: 'Try Again',
          action: () => {
            window.location.reload();
          }
        }
      ]
    );
  }

  private addNotification(notification: ErrorNotification): string {
    const current = this.notificationsSubject.value;
    this.notificationsSubject.next([...current, notification]);

    // Auto remove after timeout
    if (notification.timeout && notification.timeout > 0) {
      setTimeout(() => {
        this.remove(notification.id);
      }, notification.timeout);
    }

    return notification.id;
  }

  public remove(id: string): void {
    const current = this.notificationsSubject.value;
    this.notificationsSubject.next(current.filter(n => n.id !== id));
  }

  public clear(): void {
    this.notificationsSubject.next([]);
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}