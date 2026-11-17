import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { HttpClientModule, HTTP_INTERCEPTORS } from '@angular/common/http';
import { AuthInterceptor } from './interceptors/auth.interceptor';

// Components
import { LoginComponent } from './login/login.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { HeaderComponent } from './header/header.component';
import { SidebarComponent } from './sidebar/sidebar.component';
import { SidedetailsComponent } from './sidedetails/sidedetails.component';
import { LiveviewComponent } from './liveview/liveview.component';
import { AdduserComponent } from './adduser/adduser.component';
import { ReportsComponent } from './reports/reports.component';
import { UsermanagementComponent } from './usermanagement/usermanagement.component';
import { EscalationComponent } from './escalation/escalation.component';
import { ITLDashboardComponent } from './itl-dashboard/itl-dashboard.component';
import { OtpComponent } from './otp/otp.component';
import { ChangePasswordComponent } from './changepassword/changepassword.component';
import { ForgotPasswordComponent } from './forgotpassword/forgotpassword.component';
import { OtpComponent1 } from './forgotpassword/otp.component';
import { ChangePasswordComponent1 } from './forgotpassword/changepassword.component';
import { EditUserComponent } from './edituser/edituser.component';
import { SitemasterComponent } from './sitemaster/sitemaster.component';
import {HealthStatusComponent } from './healthstatus/healthstatus.component';
import { LiveHealthComponent } from './live-health/live-health.component';
import { AddsiteComponent } from './addsite/addsite.component';
import { EditSiteComponent } from './editsite/editsite.component';

@NgModule({
  declarations: [
    AppComponent,
    LoginComponent,
    ForgotPasswordComponent,
    DashboardComponent,
    HeaderComponent,
    SidebarComponent,
    SidedetailsComponent,
    LiveviewComponent,
    AdduserComponent,
    ReportsComponent,
    UsermanagementComponent,
    EscalationComponent,
    ITLDashboardComponent,
    OtpComponent,
    ChangePasswordComponent,
    OtpComponent1,
    ChangePasswordComponent1,
    EditUserComponent,
    SitemasterComponent,
    HealthStatusComponent,
    LiveHealthComponent,
    AddsiteComponent,
    EditSiteComponent,
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    FormsModule,
    ReactiveFormsModule,
    HttpClientModule
  ],
  providers: [
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true }
  ],
  bootstrap: [AppComponent]
})
export class AppModule {}
