// Firebase 모듈과 분리된 기본 화면 전환 코드입니다.

(function () {
  function getScreens() {
    return {
      loading: document.querySelector("#loadingScreen"),
      login: document.querySelector("#loginScreen"),
      signup: document.querySelector("#signupScreen"),
      app: document.querySelector("#appScreen"),
    };
  }

  window.showSeatCheckScreen = function (screenName) {
    const screens = getScreens();

    Object.values(screens).forEach((screen) => {
      if (screen) screen.classList.remove("active");
    });

    if (screens[screenName]) {
      screens[screenName].classList.add("active");
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    const goSignupButton = document.querySelector("#goSignupButton");
    const backToLoginButton = document.querySelector("#backToLoginButton");

    if (goSignupButton) {
      goSignupButton.addEventListener("click", function (event) {
        event.preventDefault();
        window.showSeatCheckScreen("signup");
      });
    }

    if (backToLoginButton) {
      backToLoginButton.addEventListener("click", function (event) {
        event.preventDefault();
        window.showSeatCheckScreen("login");
      });
    }
  });
})();
