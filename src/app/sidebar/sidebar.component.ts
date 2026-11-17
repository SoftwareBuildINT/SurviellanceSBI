import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent implements OnInit {
  isSidebarOpen = false;
  isReportsOpen = false;
  roleId: number = 0;   // store roleId as number

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  toggleReports() {
    this.isReportsOpen = !this.isReportsOpen;
  }

  ngOnInit() {
    // Get roleId from localStorage
    const storedRoleId = localStorage.getItem('roleId');
    this.roleId = storedRoleId ? Number(storedRoleId) : 0;
  }

  isAdmin(): boolean {
    return this.roleId === 1; // Admin only
  }
}
