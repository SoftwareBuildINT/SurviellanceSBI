import packageInfo from '../../package.json';

export const environment = {
  appVersion: packageInfo.version,
  production: false,
   //apiUrl: 'https://sbi-dashboard.ifiber.in:7668/api/'
  apiUrl: 'http://localhost:3000/'
};
