import packageInfo from '../../package.json';

export const environment = {
  appVersion: packageInfo.version,
  production: true,
  apiUrl: 'https://sbi-dashboard.ifiber.in:7668/api/'
  //apiUrl: 'http://10.30.100.68:7668/'
};
