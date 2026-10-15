// Конфигурация приложения.
//
// Сейчас работает локальный режим (localStorage).
// Чтобы подключить Firebase — заполните config ниже,
// включите firebaseConfig.enabled = true и подключите SDK
// (см. комментарий в js/storage.js).

window.APP_CONFIG = {
  appName: 'Miroz',

  // Заглушка пользователя для локального режима (когда Firebase выключен)
  localUser: {
    id: 'local-user',
    name: 'Гость',
    color: '#4262ff'
  },

  firebaseConfig: {
    enabled: true,
    apiKey: "AIzaSyAkAWAagp92pUIhDKDwcYE_Y0QdJl1X_ME",
    authDomain: "miroz-a66a1.firebaseapp.com",
    projectId: "miroz-a66a1",
    storageBucket: "miroz-a66a1.firebasestorage.app",
    messagingSenderId: "157645749621",
    appId: "1:157645749621:web:2d5b00f65fc1e9a116273c",
    measurementId: "G-WVSX8X6S11"
  }
};
