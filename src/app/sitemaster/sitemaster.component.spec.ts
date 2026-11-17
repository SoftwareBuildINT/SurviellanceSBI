import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-sitemaster',
  templateUrl: './sitemaster.component.html',
  styleUrls: ['./sitemaster.component.scss']
})
export class SitemasterComponent implements OnInit {
  sites: any[] = [];
  searchText: string = '';

  constructor() {}

  ngOnInit(): void {
    // Ideally fetch site data from API
  }

  filteredSites() {
    if (!this.searchText) return this.sites;
    return this.sites.filter(site =>
      site.atm_id.toLowerCase().includes(this.searchText.toLowerCase()) ||
      site.city.toLowerCase().includes(this.searchText.toLowerCase()) ||
      site.state.toLowerCase().includes(this.searchText.toLowerCase())
    );
  }
}
