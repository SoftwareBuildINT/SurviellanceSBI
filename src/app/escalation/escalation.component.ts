import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment'; // <-- Import environment
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

interface Level {
  id?: number;
  level: string;
  name: string;
  email: string;
  contact: string;
}

@Component({
  selector: 'app-escalation',
  templateUrl: './escalation.component.html',
  styleUrls: ['./escalation.component.scss']
})
export class EscalationComponent implements OnInit {
  escalationMatrix: Level[] = [];
  newLevel: Level = { level: '', name: '', email: '', contact: '' };

  roleId: number = 0; // store roleId from localStorage

  constructor(private http: HttpClient) { }

  ngOnInit(): void {
    this.loadLevels();
    this.getUserRole();
  }

  getUserRole() {
    // Get roleId from localStorage
    const storedRole = localStorage.getItem('roleId');
    this.roleId = storedRole ? parseInt(storedRole) : 0;
  }

  isAdmin(): boolean {
    return this.roleId === 1;  // Only roleId = 1 is admin
  }

  loadLevels() {
    this.http.get<Level[]>(`${environment.apiUrl}levels`).subscribe({
      next: (data) => this.escalationMatrix = data,
      error: (err) => console.error(err)
    });
  }
  // Validate email using regex
  isValidEmail(email: string): boolean {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailPattern.test(email);
  }

  // Validate contact: numeric & 10 digits
  isValidContact(contact: string): boolean {
    const contactPattern = /^[0-9]{10}$/;
    return contactPattern.test(contact);
  }

  // Update saveLevel and addLevel to prevent saving invalid data
  addLevel() {
    if (!this.newLevel.level || !this.newLevel.name || !this.newLevel.email || !this.newLevel.contact) {
      alert('All fields are required');
      return;
    }
    if (!this.isValidEmail(this.newLevel.email)) {
      alert('Enter a valid email');
      return;
    }
    if (!this.isValidContact(this.newLevel.contact)) {
      alert('Enter a 10-digit numeric contact');
      return;
    }

    this.http.post(`${environment.apiUrl}add-levels`, this.newLevel).subscribe({
      next: (res: any) => {
        alert('Level added successfully');
        this.newLevel = { level: '', name: '', email: '', contact: '' };
        this.loadLevels();
      },
      error: (err) => {
        console.error('Error adding level:', err);
        alert('Error adding level, check console.');
      }
    });
  }

  saveLevel(level: Level) {
    if (!level.level || !level.name || !level.email || !level.contact) {
      alert('All fields are required');
      return;
    }
    if (!this.isValidEmail(level.email)) {
      alert('Enter a valid email');
      return;
    }
    if (!this.isValidContact(level.contact)) {
      alert('Enter a 10-digit numeric contact');
      return;
    }

    this.http.put(`${environment.apiUrl}levels/${level.id}`, level).subscribe({
      next: () => alert('Level updated successfully'),
      error: (err) => console.error(err)
    });
  }
  deleteLevel(level: Level) {
    if (!level.id) return;
    if (!confirm('Are you sure you want to delete this level?')) return;

    this.http.delete(`${environment.apiUrl}levels/${level.id}`).subscribe({
      next: (res) => {
        alert('Level deleted successfully');
        this.loadLevels();
      },
      error: (err) => console.error(err)
    });
  }
  // Allow only numbers in contact field
  allowNumbersOnly(event: KeyboardEvent) {
    const charCode = event.key.charCodeAt(0);
    // Allow only numbers (0-9), Backspace, Delete
    if (charCode < 48 || charCode > 57) {
      event.preventDefault();
    }
  }
  downloadExcel() {
    if (!this.escalationMatrix || this.escalationMatrix.length === 0) {
      alert('No data to download');
      return;
    }

    // Map data for Excel
    const exportData = this.escalationMatrix.map(level => ({
      Level: level.level,
      Name: level.name,
      Email: level.email,
      Contact: level.contact
    }));

    // Create worksheet and workbook
    const ws: XLSX.WorkSheet = XLSX.utils.json_to_sheet(exportData);
    const wb: XLSX.WorkBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'EscalationMatrix');

    // Generate buffer
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    // Save file
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    saveAs(blob, 'EscalationMatrix.xlsx');
  }
  downloadTemplate() {
  window.open('/assets/sample_template.xlsx', '_blank');
}

  uploadExcel(event: any) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    this.http.post(`${environment.apiUrl}levels/upload-excel`, formData)
      .subscribe({
        next: (res: any) => {
          alert('Excel uploaded successfully and data inserted into DB!');
          this.loadLevels(); // Refresh table
        },
        error: (err) => {
          console.error(err);
          alert('Failed to upload Excel');
        }
      });
  }

}

