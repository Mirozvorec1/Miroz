// Конфигурация приложения.
//
// Firebase: Firestore — данные (проекты, элементы доски),
// Realtime Database — присутствие (курсоры). Включено, если enabled: true.

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
    measurementId: "G-WVSX8X6S11",

    // Realtime Database (для курсоров). URL из Firebase Console →
    // Realtime Database (строка вверху страницы).
    databaseURL: "https://miroz-a66a1-default-rtdb.europe-west1.firebasedatabase.app"
  }
};

