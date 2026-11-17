import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { LoginComponent } from './login/login.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { SidedetailsComponent } from './sidedetails/sidedetails.component';
import { LiveviewComponent } from './liveview/liveview.component';
import { AdduserComponent } from './adduser/adduser.component';
import { ReportsComponent } from './reports/reports.component';
import { UsermanagementComponent } from './usermanagement/usermanagement.component';
import { EscalationComponent } from './escalation/escalation.component';
import { ITLDashboardComponent } from './itl-dashboard/itl-dashboard.component';
import { OtpComponent } from './otp/otp.component';
import { AuthGuard } from './auth.guard';
import { ChangePasswordComponent } from './changepassword/changepassword.component';
import { ForgotPasswordComponent } from './forgotpassword/forgotpassword.component';
import { OtpComponent1 } from './forgotpassword/otp.component';
import { ChangePasswordComponent1 } from './forgotpassword/changepassword.component';
import { EditUserComponent } from './edituser/edituser.component';
import { SitemasterComponent } from './sitemaster/sitemaster.component';
import { HealthStatusComponent  } from './healthstatus/healthstatus.component';
import { LiveHealthComponent } from './live-health/live-health.component';
import { AddsiteComponent } from './addsite/addsite.component';
import { EditSiteComponent } from './editsite/editsite.component';
 
const routes: Routes = [
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  { path: 'forgotpassword', component: ForgotPasswordComponent },
  // OTP route (no guard, accessible after login)
  { path: 'otp', component: OtpComponent },
  { path: 'otp1', component: OtpComponent1 },
  { path: 'changepassword', component: ChangePasswordComponent, canActivate: [AuthGuard] },
  { path: 'changepassword1', component: ChangePasswordComponent1 },
  // Protected routes
  { path: 'dashboard', component: DashboardComponent, canActivate: [AuthGuard] },
  { path: 'itl-dashboard', component: ITLDashboardComponent, canActivate: [AuthGuard] },
  { path: 'sidedetails', component: SidedetailsComponent, canActivate: [AuthGuard] },
  { path: 'liveview', component: LiveviewComponent, canActivate: [AuthGuard] },
  { path: 'adduser', component: AdduserComponent, canActivate: [AuthGuard] },
  { path: 'reports', component: ReportsComponent, canActivate: [AuthGuard] },
  { path: 'usermanagement', component: UsermanagementComponent, canActivate: [AuthGuard] },
  { path: 'escalation', component: EscalationComponent, canActivate: [AuthGuard] },
  { path: 'sitemaster', component: SitemasterComponent, canActivate: [AuthGuard]},
  { path: 'users/edit/:id', component: EditUserComponent, canActivate: [AuthGuard] },
  { path: 'healthstatus', component: HealthStatusComponent, canActivate: [AuthGuard]},
  { path: 'live-health', component: LiveHealthComponent, canActivate: [AuthGuard]},
  { path: 'addsite', component: AddsiteComponent, canActivate: [AuthGuard]},
  { path: 'editsite/:id', component: EditSiteComponent, canActivate: [AuthGuard]},
  // Wildcard route for handling unknown routes
  { path: '**', redirectTo: '/login' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
