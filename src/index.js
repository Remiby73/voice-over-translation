import "./styles/main.scss";
import { VOTLocalizedError } from "./utils/VOTLocalizedError.js";
import { youtubeUtils } from "./utils/youtubeUtils.js";
import { yandexProtobuf } from "./yandexProtobuf.js";
import { getVideoId, secsToStrTime, lang } from "./utils/utils.js";
import { autoVolume } from "./config/config.js";
import {
  sitesInvidious,
  sitesPiped
} from "./config/alternativeUrls.js";
import {
  availableLangs,
  additionalTTS,
  cfOnlyExtensions,
} from "./config/constants.js";
import { localizationProvider, availableLocales } from "./localization/localizationProvider.js";
import { initDB, readDB, updateDB, deleteDB } from "./indexedDB.js";
import ui from "./ui.js";
import { syncVolume } from "./utils/volume.js";
import { workerHost } from "./config/config-cloudflare.js";
import debug from "./utils/debug.js";

import Bowser from "bowser";

import requestVideoTranslation from "./rvt.js";
import {
  getSubtitles,
  fetchSubtitles,
  SubtitlesWidget
} from "./subtitles.js";
import { courseraUtils } from "./utils/courseraUtils.js";
import { udemyUtils } from "./utils/udemyUtils.js";

import { VideoObserver } from "./utils/VideoObserver.js";
import sites from "./config/sites.js";

const browserInfo = Bowser.getParser(window.navigator.userAgent).getResult();

const sitesChromiumBlocked = [...sitesInvidious, ...sitesPiped];

const videoLipSyncEvents = ["playing", "ratechange", "play", "waiting", "pause"];

function genOptionsByOBJ(obj, conditionString) {
  console.log(obj);
  const test = obj.map((code) => ({
    label: localizationProvider.get(`langs`)[code] ?? code.toUpperCase(),
    value: code,
    selected: conditionString === code,
  }));
  console.log(test);
  return test;
}

// // translate properties
// let translateFromLang = "en"; // default language of video
// let translateToLang = lang; // default language of audio response

// let ytData = "";

// let subtitlesList = [];
// let subtitlesListVideoId = null;

// let timer;
// const audio = new Audio();
// let opacityRatio = 0.9;
// let openedMenu = false;

if (BUILD_MODE === "cloudflare") {
  var translationPanding = false;
}

function translateVideo(
  url,
  duration,
  requestLang,
  responseLang,
  translationHelp,
  callback
) {
  debug.log(
    `Translate video (url: ${url}, duration: ${duration}, requestLang: ${requestLang}, responseLang: ${responseLang})`
  );

  debug.log("translationHelp:", translationHelp);

  if (BUILD_MODE === "cloudflare" && translationPanding) {
    debug.log("translationPanding return");
    return;
  }

  translationPanding = true;

  requestVideoTranslation(
    url,
    duration,
    requestLang,
    responseLang,
    translationHelp,
    (success, response) => {
      translationPanding = false;

      debug.log("[exec callback] Requesting video translation");
      if (!success) {
        callback(false, localizationProvider.get("requestTranslationFailed"));
        return;
      }

      const translateResponse =
        yandexProtobuf.decodeTranslationResponse(response);
      console.log("[VOT] Translation response: ", translateResponse);

      switch (translateResponse.status) {
        case 0:
          callback(false, translateResponse.message);
          break;
        case 1:
          callback(
            !!translateResponse.url,
            translateResponse.url ||
              localizationProvider.get("audioNotReceived")
          );
          break;
        case 2:
          callback(
            false,
            translateResponse.remainingTime
              ? secsToStrTime(translateResponse.remainingTime)
              : localizationProvider.get("translationTakeFewMinutes")
          );
          break;
        case 3:
          /*
            Иногда, в ответе приходит статус код 3, но видео всё, так же, ожидает перевода.
            В конечном итоге, это занимает слишком много времени,
            как-будто сервер не понимает, что данное видео уже недавно было переведено
            и заместо возвращения готовой ссылки на перевод начинает переводить видео заново
            при чём у него это получается за очень длительное время.
          */
          callback(false, localizationProvider.get("videoBeingTranslated"));
          break;
      }
    }
  );
}

class VideoHandler {
  // translate properties
  translateFromLang = "en"; // default language of video
  translateToLang = lang; // default language of audio response

  timer;

  ytData = "";
  videoData = "";
  firstPlay = true;
  audio = new Audio();
  downloadTranslationUrl = null;

  autoRetry;
  volumeOnStart;
  tempOriginalVolume;
  tempVolume;

  subtitlesList = [];
  subtitlesListVideoId = null;

  constructor(video, container, site) {
    debug.log("[VideoHandler] add video:", video, "container:", container, this);
    this.video = video;
    this.container = container;
    this.site = site;
    this.handleSrcChangedBound = this.handleSrcChanged.bind(this);
    this.srcObserver = new MutationObserver(this.handleSrcChangedBound);
    this.srcObserver.observe(this.video, {
      attributeFilter: ["src", "currentSrc"]
    });
    this.stopTranslationBound = this.stopTranslation.bind(this);
    this.handleVideoEventBound = this.handleVideoEvent.bind(this);
    this.changeOpacityOnEventBound = this.changeOpacityOnEvent.bind(this);
    this.resetTimerBound = this.resetTimer.bind(this);
    this.init();
  }

  async init() {
    this.data = await readDB() ?? {};
    this.videoData = await this.getVideoData();

    debug.log("[db] data from db: ", this.data);

    this.subtitlesWidget = new SubtitlesWidget(this.video, this.container, this.site);
    this.subtitlesWidget.setMaxLength(this.data.subtitlesMaxLength);
    this.subtitlesWidget.setHighlightWords(this.data.highlightWords);

    this.initUI();
    this.initUIEvents();

    this.votButton.container.hidden = !this.video.src && !this.video.currentSrc;
    !this.video.src && !this.video.currentSrc && (this.votMenu.container.hidden = !this.video.src && !this.video.currentSrc);

    await this.updateSubtitles();
    await this.changeSubtitlesLang("disabled");
    this.setSelectMenuValues(this.videoData.detectedLanguage, this.data.responseLanguage ?? "ru");
    this.translateToLang = this.data.responseLanguage ?? "ru";

    this.initExtraEvents();
  }

  transformBtn(status = "none", text) {
    this.votButton.container.dataset.status = status;
    this.votButton.label.innerHTML = text;
  }

  initUI() {
    // VOT Button
    {
      this.votButton = ui.createVOTButton(localizationProvider.get("translateVideo"));
      this.container.appendChild(this.votButton.container);

      this.votButton.container.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      });
    }

    // VOT Menu
    {
      this.votMenu = ui.createVOTMenu(localizationProvider.get("VOTSettings"));
      this.container.appendChild(this.votMenu.container);

      this.votDownloadButton = ui.createIconButton(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="100%" viewBox="0 -960 960 960"><path d="M480-337q-8 0-15-2.5t-13-8.5L308-492q-12-12-11.5-28t11.5-28q12-12 28.5-12.5T365-549l75 75v-286q0-17 11.5-28.5T480-800q17 0 28.5 11.5T520-760v286l75-75q12-12 28.5-11.5T652-548q11 12 11.5 28T652-492L508-348q-6 6-13 8.5t-15 2.5ZM240-160q-33 0-56.5-23.5T160-240v-80q0-17 11.5-28.5T200-360q17 0 28.5 11.5T240-320v80h480v-80q0-17 11.5-28.5T760-360q17 0 28.5 11.5T800-320v80q0 33-23.5 56.5T720-160H240Z"/></svg>`);
      this.votDownloadButton.hidden = true;
      this.votMenu.headerContainer.appendChild(this.votDownloadButton);

      this.votSettingsButton = ui.createIconButton(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="100%" viewBox="0 -960 960 960"><path d="M555-80H405q-15 0-26-10t-13-25l-12-93q-13-5-24.5-12T307-235l-87 36q-14 5-28 1t-22-17L96-344q-8-13-5-28t15-24l75-57q-1-7-1-13.5v-27q0-6.5 1-13.5l-75-57q-12-9-15-24t5-28l74-129q7-14 21.5-17.5T220-761l87 36q11-8 23-15t24-12l12-93q2-15 13-25t26-10h150q15 0 26 10t13 25l12 93q13 5 24.5 12t22.5 15l87-36q14-5 28-1t22 17l74 129q8 13 5 28t-15 24l-75 57q1 7 1 13.5v27q0 6.5-2 13.5l75 57q12 9 15 24t-5 28l-74 128q-8 13-22.5 17.5T738-199l-85-36q-11 8-23 15t-24 12l-12 93q-2 15-13 25t-26 10Zm-73-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm0-80q-25 0-42.5-17.5T422-480q0-25 17.5-42.5T482-540q25 0 42.5 17.5T542-480q0 25-17.5 42.5T482-420Zm-2-60Zm-40 320h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Z"/></svg>`);
      this.votMenu.headerContainer.appendChild(this.votSettingsButton);

      this.votTranslationLanguageSelect = ui.createVOTLanguageSelect(
        [
          {
            label: localizationProvider.get("videoLanguage"),
            value: "default",
            disabled: true,
          },
          ...genOptionsByOBJ(availableLangs, this.videoData.detectedLanguage),
        ],
        [
          {
            label: localizationProvider.get("translationLanguage"),
            value: "default",
            disabled: true,
          },
          ...genOptionsByOBJ(availableLangs, this.videoData.responseLanguage),
          {
            label: "─────────",
            value: "separator",
            disabled: true,
          },
          ...genOptionsByOBJ(additionalTTS, this.videoData.responseLanguage),
        ]
      );
      this.votMenu.bodyContainer.appendChild(this.votTranslationLanguageSelect.container);

      this.votSubtitlesSelect = ui.createSelect(localizationProvider.get("VOTSubtitles"), [
        {
          label: localizationProvider.get("VOTSubtitlesDisabled"),
          value: "disabled",
          disabled: false,
        }
      ]);
      this.votMenu.bodyContainer.appendChild(this.votSubtitlesSelect.container);

      this.votVideoVolumeSlider = ui.createSlider(`${localizationProvider.get("VOTVolume")}: <strong>${this.getVideoVolume() * 100}%</strong>`, this.getVideoVolume() * 100);
      this.votVideoVolumeSlider.container.hidden = this.data.showVideoSlider !== 1 || this.votButton.container.dataset.status !== "success";
      this.votMenu.bodyContainer.appendChild(this.votVideoVolumeSlider.container);

      this.votVideoTranslationVolumeSlider = ui.createSlider(`${localizationProvider.get("VOTVolumeTranslation")}: <strong>${this.data?.defaultVolume ?? 100}%</strong>`, this.data?.defaultVolume ?? 100);
      this.votVideoTranslationVolumeSlider.container.hidden = this.votButton.container.dataset.status !== "success";
      this.votMenu.bodyContainer.appendChild(this.votVideoTranslationVolumeSlider.container);

      this.votMenu.container.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      });
    }

    // VOT Settings
    {
      this.votSettingsDialog = ui.createDialog(localizationProvider.get("VOTSettings"));
      document.documentElement.appendChild(this.votSettingsDialog.container);

      this.votTranslationHeader = ui.createHeader(localizationProvider.get("translationSettings"));
      this.votSettingsDialog.bodyContainer.appendChild(this.votTranslationHeader);

      this.votAutoTranslateCheckbox = ui.createCheckbox(localizationProvider.get("VOTAutoTranslate"), this.data?.autoTranslate ?? false);
      this.votSettingsDialog.bodyContainer.appendChild(this.votAutoTranslateCheckbox.container);

      this.votDontTranslateYourLangCheckbox = ui.createCheckbox(localizationProvider.get("VOTDontTranslateYourLang"), this.data?.dontTranslateYourLang ?? true);
      this.votSettingsDialog.bodyContainer.appendChild(this.votDontTranslateYourLangCheckbox.container);

      this.votAutoSetVolumeCheckbox = ui.createCheckbox(`${localizationProvider.get("VOTAutoSetVolume")} ${autoVolume * 100}%`, this.data?.autoSetVolumeYandexStyle ?? true);
      this.votSettingsDialog.bodyContainer.appendChild(this.votAutoSetVolumeCheckbox.container);

      this.votShowVideoSliderCheckbox = ui.createCheckbox(localizationProvider.get("VOTShowVideoSlider"), this.data?.showVideoSlider ?? false);
      this.votSettingsDialog.bodyContainer.appendChild(this.votShowVideoSliderCheckbox.container);

      // udemy only
      this.votUdemyDataTextfield = ui.createTextfield(localizationProvider.get("VOTUdemyData"), this.data?.udemyData?.accessToken ?? "");
      this.votUdemyDataTextfield.container.hidden = this.site.host !== "udemy";
      this.votSettingsDialog.bodyContainer.appendChild(this.votUdemyDataTextfield.container);

      // youtube only
      this.votSyncVolumeCheckbox = ui.createCheckbox(localizationProvider.get("VOTSyncVolume"), this.data?.syncVolume ?? false);
      this.votSyncVolumeCheckbox.container.hidden = this.site.host !== "youtube" || this.site.additionalData === "mobile";
      this.votSettingsDialog.bodyContainer.appendChild(this.votSyncVolumeCheckbox.container);

      // cf version only
      this.votAudioProxyCheckbox = ui.createCheckbox(localizationProvider.get("VOTAudioProxy"), this.data?.audioProxy ?? false);
      this.votAudioProxyCheckbox.container.hidden = BUILD_MODE !== "cloudflare";
      this.votSettingsDialog.bodyContainer.appendChild(this.votAudioProxyCheckbox.container);

      // SUBTITLES

      this.votSubtitlesHeader = ui.createHeader(localizationProvider.get("subtitlesSettings"));
      this.votSettingsDialog.bodyContainer.appendChild(this.votSubtitlesHeader);

      this.votSubtitlesMaxLengthSlider = ui.createSlider(`${localizationProvider.get("VOTSubtitlesMaxLength")}: <strong>${this.data?.subtitlesMaxLength ?? 300}</strong>`, this.data?.subtitlesMaxLength ?? 300, 50, 300);
      this.votSettingsDialog.bodyContainer.appendChild(this.votSubtitlesMaxLengthSlider.container);

      this.votSubtitlesHighlightWordsCheckbox = ui.createCheckbox(localizationProvider.get("VOTHighlightWords"), this.data?.highlightWords ?? false);
      this.votSettingsDialog.bodyContainer.appendChild(this.votSubtitlesHighlightWordsCheckbox.container);

      // ABOUT

      this.votAboutHeader = ui.createHeader(localizationProvider.get("about"));
      this.votSettingsDialog.bodyContainer.appendChild(this.votAboutHeader);

      this.votLanguageSelect = ui.createSelect(localizationProvider.get("VOTMenuLanguage"), genOptionsByOBJ(availableLocales, window.localStorage.getItem("vot-locale-lang-override") ?? "auto"));
      this.votSettingsDialog.bodyContainer.appendChild(this.votLanguageSelect.container);

      this.votVersionInfo = ui.createInformation(`${localizationProvider.get("VOTVersion")}:`, BUILD_MODE === "cloudflare" ? `cloudflare ${GM_info.script.version}` : GM_info.script.version);
      this.votSettingsDialog.bodyContainer.appendChild(this.votVersionInfo.container);

      this.votAuthorsInfo = ui.createInformation(`${localizationProvider.get("VOTAuthors")}:`, GM_info.script.author);
      this.votSettingsDialog.bodyContainer.appendChild(this.votAuthorsInfo.container);

      this.votLoaderInfo = ui.createInformation(`${localizationProvider.get("VOTLoader")}:`, `${GM_info.scriptHandler} v${GM_info.version}`);
      this.votSettingsDialog.bodyContainer.appendChild(this.votLoaderInfo.container);

      this.votBrowserInfo = ui.createInformation(`${localizationProvider.get("VOTBrowser")}:`, `${browserInfo.browser.name} ${browserInfo.browser.version} (${browserInfo.os.name} ${browserInfo.os.version})`);
      this.votSettingsDialog.bodyContainer.appendChild(this.votBrowserInfo.container);

      this.votResetSettingsButton = ui.createButton(localizationProvider.get("resetSettings"));
      this.votSettingsDialog.bodyContainer.appendChild(this.votResetSettingsButton);
    }
  }

  initUIEvents() {
    // VOT Button
    {
      this.votButton.translateButton.addEventListener("click", async () => {
        if (this.audio.src) {
          debug.log("[click translationBtn] audio.src is not empty");
          this.stopTraslate();
          return;
        }

        try {
          debug.log("[click translationBtn] trying execute translation");
          const VIDEO_ID = getVideoId(this.site.host, this.video);

          if (!VIDEO_ID) {
            throw new VOTLocalizedError("VOTNoVideoIDFound");
          }

          await this.translateExecutor(VIDEO_ID);
        } catch (err) {
          console.error("[VOT]", err);
          if (err?.name === "VOTLocalizedError") {
            this.transformBtn("error", err.localizedMessage);
          } else {
            this.transformBtn("error", err);
          }
        }
      });

      this.votButton.menuButton.addEventListener("click", () => {
        this.votMenu.container.hidden = !this.votMenu.container.hidden;
      });
    }

    // VOT Menu
    {
      this.votDownloadButton.addEventListener("click", () => {
        if (this.downloadTranslationUrl) {
          window.open(this.downloadTranslationUrl, "_blank").focus();
        }
      });

      this.votSettingsButton.addEventListener("click", () => {
        this.votSettingsDialog.container.hidden = !this.votSettingsDialog.container.hidden;
        if (document.fullscreen === undefined || document.fullscreen) {
          document.webkitExitFullscreen && document.webkitExitFullscreen();
          document.mozCancelFullscreen && document.mozCancelFullscreen();
          document.exitFullscreen && document.exitFullscreen();
        }
      });

      this.votTranslationLanguageSelect.fromSelect.addEventListener("change", async (e) => {
        debug.log("[onchange] select from language", e.target.value);
        this.videoData = await this.getVideoData();
        await this.setSelectMenuValues(
          e.target.value,
          this.videoData.responseLanguage
        );
      });

      this.votTranslationLanguageSelect.toSelect.addEventListener("change", async (e) => {
        debug.log("[onchange] select to language", e.target.value);
        this.data.responseLanguage = this.translateToLang = e.target.value;
        await updateDB({ responseLanguage: this.data.responseLanguage });
        debug.log("Response Language value changed. New value: ", this.data.responseLanguage);
        this.videoData = await this.getVideoData();
        await this.setSelectMenuValues(
          this.videoData.detectedLanguage,
          this.data.responseLanguage
        );
      });

      this.votSubtitlesSelect.select.addEventListener("change", async (e) => {
        await this.changeSubtitlesLang(e.target.value);
      });

      this.votVideoVolumeSlider.input.addEventListener("input", (e) => {
        const value = Number(e.target.value);
        this.votVideoVolumeSlider.label.querySelector("strong").innerHTML = `${value}%`;
        this.setVideoVolume(value / 100);
        if (this.data.syncVolume === 1) {
          const translateVolume = Number(this.votVideoTranslationVolumeSlider.input.value);
          const finalValue = syncVolume(
            this.audio,
            value,
            translateVolume,
            this.tempOriginalVolume
          );

          this.votVideoTranslationVolumeSlider.input.value = finalValue;
          this.votVideoTranslationVolumeSlider.label.querySelector("strong").innerHTML = `${finalValue}%`;
          ui.updateSlider(this.votVideoTranslationVolumeSlider.input);

          this.tempVolume = finalValue;
          this.tempOriginalVolume = value;
        }
      });

      this.votVideoTranslationVolumeSlider.input.addEventListener("input", async (e) => {
        this.data.defaultVolume = Number(e.target.value);
        await updateDB({ defaultVolume: this.data.defaultVolume });
        this.votVideoTranslationVolumeSlider.label.querySelector("strong").innerHTML = `${this.data.defaultVolume}%`;
        this.audio.volume = this.data.defaultVolume / 100;
        if (this.data.syncVolume === 1) {
          this.syncTranslationWithVideo(this.data.defaultVolume);
        }
      });
    }

    // VOT Settings
    {
      this.votAutoTranslateCheckbox.input.addEventListener("change", async (e) => {
        this.data.autoTranslate = Number(e.target.checked);
        await updateDB({ autoTranslate: this.data.autoTranslate });
        debug.log("autoTranslate value changed. New value: ", this.data.autoTranslate);
      });

      this.votDontTranslateYourLangCheckbox.input.addEventListener("change", async (e) => {
        this.data.dontTranslateYourLang = Number(e.target.checked);
        await updateDB({ dontTranslateYourLang: this.data.dontTranslateYourLang });
        debug.log("dontTranslateYourLang value changed. New value: ", this.data.dontTranslateYourLang);
      });

      this.votAutoSetVolumeCheckbox.input.addEventListener("change", async (e) => {
        this.data.autoSetVolumeYandexStyle = Number(e.target.checked);
        await updateDB({ autoSetVolumeYandexStyle: this.data.autoSetVolumeYandexStyle });
        debug.log("autoSetVolumeYandexStyle value changed. New value: ", this.data.autoSetVolumeYandexStyle);
      });

      this.votShowVideoSliderCheckbox.input.addEventListener("change", async (e) => {
        this.data.showVideoSlider = Number(e.target.checked);
        await updateDB({ showVideoSlider: this.data.showVideoSlider });
        debug.log("showVideoSlider value changed. New value: ", this.data.showVideoSlider);
        this.votVideoVolumeSlider.container.hidden = this.data.showVideoSlider !== 1 || this.votButton.container.dataset.status !== "success";
      });

      this.votUdemyDataTextfield.input.addEventListener("change", async (e) => {
        this.data.udemyData = {
          accessToken: e.target.value,
          expires: new Date().getTime(),
        };
        await updateDB({ udemyData: this.data.udemyData });
        debug.log("udemyData value changed. New value: ", this.data.udemyData);
        window.location.reload();
      });

      this.votSyncVolumeCheckbox.input.addEventListener("change", async (e) => {
        this.data.syncVolume = Number(e.target.checked);
        await updateDB({ syncVolume: this.data.syncVolume });
        debug.log("syncVolume value changed. New value: ", this.data.syncVolume);
      });

      this.votAudioProxyCheckbox.input.addEventListener("change", async (e) => {
        this.data.audioProxy = Number(e.target.checked);
        await updateDB({ audioProxy: this.data.audioProxy });
        debug.log("audioProxy value changed. New value: ", this.data.audioProxy);
      });

      this.votSubtitlesMaxLengthSlider.input.addEventListener("input", async (e) => {
        this.data.subtitlesMaxLength = Number(e.target.value);
        await updateDB({ subtitlesMaxLength: this.data.subtitlesMaxLength });
        this.votSubtitlesMaxLengthSlider.label.querySelector("strong").innerHTML = `${this.data.subtitlesMaxLength}`;
        this.subtitlesWidget.setMaxLength(this.data.subtitlesMaxLength);
      });

      this.votSubtitlesHighlightWordsCheckbox.input.addEventListener("change", async (e) => {
        this.data.highlightWords = Number(e.target.checked);
        await updateDB({ highlightWords: this.data.highlightWords });
        debug.log("highlightWords value changed. New value: ", this.data.highlightWords);
        this.subtitlesWidget.setHighlightWords(this.data.highlightWords);
      });

      this.votLanguageSelect.select.addEventListener("change", (e) => {
        window.localStorage.setItem("vot-locale-lang-override", e.target.value);
      });

      this.votResetSettingsButton.addEventListener("click", () => {
        localizationProvider.reset();
        deleteDB();
        window.location.reload();
      });
    }
  }

  releaseExtraEvents() {
    clearInterval(this.resizeInterval);
    this.resizeObserver.disconnect();
    if (this.site.host === "youtube" && this.site.additionalData !== "mobile") {
      this.syncVolumeObserver.disconnect();
    }

    this.extraEvents?.forEach((e) => {
      e.element.removeEventListener(e.event, e.handler);
    });
  }

  initExtraEvents() {
    this.extraEvents = [];

    const addExtraEventListener = (element, event, handler) => {
      this.extraEvents.push({
        element,
        event,
        handler
      });
      element.addEventListener(event, handler);
    };

    const addExtraEventListeners = (element, events, handler) => {
      events.forEach((event) => {
        addExtraEventListener(element, event, handler);
      });
    };

    this.resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((e) => {
        this.votMenu.container.setAttribute("style", `--vot-container-height: ${e.contentRect.height}px`);
      });
    });
    this.resizeObserver.observe(this.video);
    this.votMenu.container.setAttribute("style", `--vot-container-height: ${this.video.getBoundingClientRect().height}px`);
    this.resizeInterval = setInterval(() => {
      this.votMenu.container.setAttribute("style", `--vot-container-height: ${this.video.getBoundingClientRect().height}px`);
    }, 500);
    // Sync volume slider with original video (youtube only)
    if (this.site.host === "youtube" && this.site.additionalData !== "mobile") {
      this.syncVolumeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "aria-valuenow"
          ) {
            this.syncVideoVolumeSlider();
          }
        });
      });

      const ytpVolumePanel = document.querySelector(".ytp-volume-panel");
      if (ytpVolumePanel) {
        this.syncVolumeObserver.observe(ytpVolumePanel, {
          attributes: true,
          childList: false,
          subtree: true,
          attributeOldValue: true,
        });
      }
    }

    document.addEventListener("click", (event) => {
      const e = event.target;

      const button = this.votButton.container;
      const menu = this.votMenu.container;
      const container = this.container;
      const settings = this.votSettingsDialog.container;

      const isButton = button.contains(e);
      const isMenu = menu.contains(e);
      const isVideo = container.contains(e);
      const isSettings = settings.contains(e);

      debug.log(`[document click] ${isButton} ${isMenu} ${isVideo} ${isSettings}`);
      if (!(!isButton && !isMenu && !isSettings)) return;
      if (!isVideo) this.logout(0);

      this.votMenu.container.hidden = true;
    });

    let eContainer;
    if (this.site.host === "pornhub") {
      if (this.site.additionalData === "embed") {
        eContainer = document.querySelector("#player");
      } else {
        // const e = document.querySelector(".original.mainPlayerDiv > video-element > div");
        eContainer = this.container.querySelector("video-element > div");
      }
    } else if (this.site.host === "twitter") {
      eContainer = document.querySelector('div[data-testid="videoPlayer"');
    } else {
      eContainer = this.container;
    }
    addExtraEventListeners(eContainer, ["mousemove", "mouseout"], this.resetTimerBound);

    addExtraEventListener(this.votButton.container, "mousemove" , this.changeOpacityOnEventBound);
    addExtraEventListener(this.votMenu.container, "mousemove" , this.changeOpacityOnEventBound);
    addExtraEventListeners(document, ["touchstart", "touchmove", "touchend"], this.changeOpacityOnEventBound);

    addExtraEventListener(this.video, "abort", () => {
      debug.log("lipsync mode is abort");
      this.stopTranslation();
      this.videoData = "";
    });

    addExtraEventListener(this.video, "progress", async () => {
      if (!(this.firstPlay && this.data.autoTranslate === 1)) {
        return;
      }
      const VIDEO_ID = getVideoId(this.site.host, this.video);

      if (!VIDEO_ID) {
        throw new VOTLocalizedError("VOTNoVideoIDFound");
      }

      try {
        await this.translateExecutor(VIDEO_ID);
        this.firstPlay = false;
      } catch (err) {
        console.error("[VOT]", err);
        if (err?.name === "VOTLocalizedError") {
          this.transformBtn("error", err.localizedMessage);
        } else {
          this.transformBtn("error", err);
        }
        this.firstPlay = false;
      }
    });
  }

  logout(n) {
    if (!this.votMenu.container.hidden) return;
    this.votButton.container.style.opacity = n;
  }

  resetTimer() {
    clearTimeout(this.timer);
    this.logout(1);
    this.timer = setTimeout(() => {
      this.logout(0);
    }, 2000);
  }

  changeOpacityOnEvent(event) {
    clearTimeout(this.timer);
    this.logout(1);
    event.stopPropagation();
  }

  async changeSubtitlesLang(subs) {
    debug.log("[onchange] subtitles", subs);
    this.votSubtitlesSelect.select.value = subs;
    if (subs === "disabled") {
      this.subtitlesWidget.setContent(null);
    } else {
      this.subtitlesWidget.setContent(await fetchSubtitles(this.subtitlesList.at(parseInt(subs))));
    }
  }

  async updateSubtitlesLangSelect() {
    const oldValue = this.votSubtitlesSelect.select.value;
    this.votSubtitlesSelect.select.innerHTML = "";

    const disabledOption = document.createElement("option");
    disabledOption.value = "disabled";
    disabledOption.innerHTML = localizationProvider.get("VOTSubtitlesDisabled");
    this.votSubtitlesSelect.select.append(disabledOption);

    for (let i = 0; i < this.subtitlesList.length; i++) {
      const s = this.subtitlesList[i];
      const option = document.createElement("option");
      option.value = i;
      option.innerHTML =
        (localizationProvider.get("langs")[s.language] ??
          s.language.toUpperCase()) +
        (s.translatedFromLanguage
          ? ` ${localizationProvider.get("VOTTranslatedFrom")} ${
              localizationProvider.get("langs")[s.translatedFromLanguage] ??
              s.translatedFromLanguage.toUpperCase()
            }`
          : "") +
        (s.source !== "yandex" ? ` ${s.source}` : "") +
        (s.isAutoGenerated
          ? ` (${localizationProvider.get("VOTAutogenerated")})`
          : "");
          this.votSubtitlesSelect.select.append(option);
    }

    await this.changeSubtitlesLang(oldValue);
  }

  async updateSubtitles() {
    await this.changeSubtitlesLang("disabled");

    const VIDEO_ID = getVideoId(this.site.host, this.video);

    if (!VIDEO_ID) {
      console.error(
        `[VOT] ${localizationProvider.getDefault("VOTNoVideoIDFound")}`
      );
      this.subtitlesList = [];
      this.subtitlesListVideoId = null;
      await this.updateSubtitlesLangSelect();
      return;
    }

    if (this.subtitlesListVideoId === VIDEO_ID) {
      return;
    }

    if (!this.videoData.detectedLanguage) {
      this.videoData = await this.getVideoData();
      await this.setSelectMenuValues(
        this.videoData.detectedLanguage,
        this.videoData.responseLanguage
      );
    }

    this.subtitlesList = await getSubtitles(
      this.site,
      VIDEO_ID,
      this.videoData.detectedLanguage
    );
    if (!this.subtitlesList) {
      await this.changeSubtitlesLang("disabled");
    } else {
      this.subtitlesListVideoId = VIDEO_ID;
    }
    await this.updateSubtitlesLangSelect();
  }

  // Get video volume in 0.00-1.00 format
  getVideoVolume() {
    let videoVolume = this.video?.volume;
    if (this.site.host === "youtube") {
      videoVolume = youtubeUtils.getVideoVolume() || videoVolume;
    }
    return videoVolume;
  }

  // Set video volume in 0.00-1.00 format
  setVideoVolume(volume) {
    if (this.site.host === "youtube") {
      return youtubeUtils.setVideoVolume(volume);
    }
    this.video.volume = volume;
  }

  // Sync volume slider with original video (youtube only)
  syncVideoVolumeSlider() {
    const newSlidersVolume = Math.round(this.getVideoVolume() * 100);

    this.votVideoVolumeSlider.input.value = newSlidersVolume;
    this.votVideoVolumeSlider.label.querySelector("strong").innerHTML = `${newSlidersVolume}%`;
    ui.updateSlider(this.votVideoVolumeSlider.input);

    if (this.data.syncVolume === 1) {
      this.tempOriginalVolume = Number(newSlidersVolume);
    }
  }

  setSelectMenuValues(from, to) {
    this.votTranslationLanguageSelect.fromSelect.value = from;
    this.votTranslationLanguageSelect.toSelect.value = to;
    console.log(`[VOT] Set translation from ${from} to ${to}`);
    this.videoData.detectedLanguage = from;
    this.videoData.responseLanguage = to;
  }

  // A helper function to sync translation volume with video volume
  syncTranslationWithVideo(translationValue) {
    // Get the video volume value
    const videoVolume = Number(this.votVideoVolumeSlider.input.value);

    // Calculate the synced video volume based on the translation volume
    const finalValue = syncVolume(
      this.video,
      translationValue,
      videoVolume,
      this.tempVolume
    );

    // Set the video volume slider value to the synced value
    this.votVideoVolumeSlider.input.value = finalValue;
    this.votVideoVolumeSlider.label.querySelector("strong").innerHTML = `${finalValue}%`;
    ui.updateSlider(this.votVideoVolumeSlider.input);

    // Update the temp variables for future syncing
    this.tempOriginalVolume = finalValue;
    this.tempVolume = translationValue;
  }

  async getVideoData() {
    const videoData = {};

    videoData.translationHelp = null; // ! should be null for ALL websites except coursera and udemy !
    videoData.duration = this.video?.duration || 343; // ! if 0 - we get 400 error
    videoData.videoId = getVideoId(this.site.host, this.video);
    videoData.detectedLanguage = this.translateFromLang;
    videoData.responseLanguage = this.translateToLang;

    if (!videoData.videoId) {
      this.ytData = {};
      return videoData;
    }

    if (window.location.hostname.includes("youtube.com")) {
      this.ytData = await youtubeUtils.getVideoData();
      if (this.ytData.author !== "") {
        videoData.detectedLanguage = this.ytData.detectedLanguage;
        videoData.responseLanguage = this.translateToLang;
      }
    } else if (
      window.location.hostname.includes("rutube") ||
      window.location.hostname.includes("my.mail.ru")
    ) {
      videoData.detectedLanguage = "ru";
    } else if (window.location.hostname.includes("bilibili.com")) {
      videoData.detectedLanguage = "zh";
    } else if (window.location.hostname.includes("coursera.org")) {
      const courseraData = await courseraUtils.getVideoData(this.translateToLang);
      videoData.duration = courseraData.duration || videoData.duration; // courseraData.duration sometimes it can be equal to NaN
      videoData.detectedLanguage = courseraData.detectedLanguage;
      videoData.translationHelp = courseraData.translationHelp;
    } else if (window.location.hostname.includes("udemy.com")) {
      const udemyData = await udemyUtils.getVideoData(
        this.data.udemyData,
        this.translateToLang
      );
      videoData.duration = udemyData.duration || videoData.duration;
      videoData.detectedLanguage = udemyData.detectedLanguage;
      videoData.translationHelp = udemyData.translationHelp;
    }

    return videoData;
  }

  videoValidator() {
    if (this.site.host === "youtube") {
      debug.log("VideoValidator videoData: ", this.videoData);
      if (
        this.data.dontTranslateYourLang === 1 &&
        this.videoData.detectedLanguage === lang &&
        this.videoData.responseLanguage === lang
      ) {
        throw new VOTLocalizedError("VOTDisableFromYourLang");
      }
      if (this.ytData.isPremiere) {
        throw new VOTLocalizedError("VOTPremiere");
      }
      if (this.ytData.isLive) {
        throw new VOTLocalizedError("VOTLiveNotSupported");
      }
      if (this.videoData.duration > 14_400) {
        throw new VOTLocalizedError("VOTVideoIsTooLong");
      }
    }
    return true;
  }

  lipSync(mode = false) {
    debug.log("lipsync video", this.video);
    if (!this.video) {
      return;
    }
    this.audio.currentTime = this.video.currentTime;
    this.audio.playbackRate = this.video.playbackRate;

    if (!mode) {
      debug.log("lipsync mode is not set");
      return;
    }

    if (mode === "play") {
      debug.log("lipsync mode is play");
      const audioPromise = this.audio.play();
      if (audioPromise !== undefined) {
        audioPromise.catch((e) => {
          console.error("[VOT]", e);
          if (e.name === "NotAllowedError") {
            this.transformBtn(
              "error",
              localizationProvider.get("grantPermissionToAutoPlay")
            );
            throw new VOTLocalizedError("grantPermissionToAutoPlay");
          } else if (e.name === "NotSupportedError") {
            this.transformBtn(
              "error",
              sitesChromiumBlocked.includes(window.location.hostname)
                ? localizationProvider.get("neededAdditionalExtension")
                : localizationProvider.get("audioFormatNotSupported")
            );
            throw sitesChromiumBlocked.includes(window.location.hostname)
              ? new VOTLocalizedError("neededAdditionalExtension")
              : new VOTLocalizedError("audioFormatNotSupported");
          }
        });
      }
      return;
    }
    if (mode === "pause") {
      debug.log("lipsync mode is pause");
      this.audio.pause();
    }
    if (mode === "stop") {
      debug.log("lipsync mode is stop");
      this.audio.pause();
    }
    if (mode === "waiting") {
      debug.log("lipsync mode is waiting");
      this.audio.pause();
    }
    if (mode === "playing") {
      debug.log("lipsync mode is playing");
      this.audio.play();
    }
  }

  // Define a function to handle common events
  handleVideoEvent(event) {
    debug.log(`video ${event.type}`);
    this.lipSync(event.type);
  }

  // Default actions on stop translate
  stopTraslate() {
    videoLipSyncEvents.forEach((e) => this.video.removeEventListener(e, this.handleVideoEventBound));
    this.audio.pause();
    //! video.removeEventListener(".translate", stopTraslate, false); // why???
    this.audio.src = "";
    this.audio.removeAttribute("src");
    this.votVideoVolumeSlider.container.hidden = true;
    this.votVideoTranslationVolumeSlider.container.hidden = true;
    this.votDownloadButton.hidden = true;
    this.downloadTranslationUrl = null;
    this.transformBtn("none", localizationProvider.get("translateVideo"));
    if (this.volumeOnStart) {
      debug.log(`Volume on start: ${this.volumeOnStart}`);
      if (this.site.host === "youtube") {
        youtubeUtils.setVideoVolume(this.volumeOnStart);
      } else {
        this.video.volume = this.volumeOnStart;
      }
    }
  }

  async translateExecutor(VIDEO_ID) {
    if (!this.videoData.detectedLanguage) {
      this.videoData = await this.getVideoData();
      this.setSelectMenuValues(
        this.videoData.detectedLanguage,
        this.videoData.responseLanguage
      );
    }
    debug.log("Run videoValidator");
    this.videoValidator();
    debug.log("Run translateFunc");
    this.translateFunc(
      VIDEO_ID,
      this.videoData.detectedLanguage,
      this.videoData.responseLanguage,
      this.videoData.translationHelp
    );
  }

  // Define a function to translate a video and handle the callback
  translateFunc(
    VIDEO_ID,
    requestLang,
    responseLang,
    translationHelp
  ) {
    console.log("[VOT] Video Data: ", this.videoData);
    const videoURL = `${this.site.url}${VIDEO_ID}`;
    if (["udemy", "coursera"].includes(this.site.host) && !translationHelp) {
      throw new VOTLocalizedError("VOTTranslationHelpNull");
    }
    translateVideo(
      videoURL,
      this.videoData.duration,
      requestLang,
      responseLang,
      translationHelp,
      (success, urlOrError) => {
        debug.log("[exec callback] translateVideo");
        if (getVideoId(this.site.host, this.video) !== VIDEO_ID) return;
        if (!success) {
          if (urlOrError?.name === "VOTLocalizedError") {
            this.transformBtn("error", urlOrError.localizedMessage);
          } else {
            this.transformBtn("error", urlOrError);
          }
          // if the error line contains information that the translation is being performed, then we wait
          if (
            urlOrError.includes(localizationProvider.get("translationTake"))
          ) {
            clearTimeout(this.autoRetry);
            this.autoRetry = setTimeout(
              () =>
                this.translateFunc(
                  VIDEO_ID,
                  requestLang,
                  responseLang,
                  translationHelp
                ),
              60_000
            );
          }
          console.error("[VOT]", urlOrError);
          return;
        }

        this.audio.src = urlOrError;

        // cf version only
        if (
          BUILD_MODE === "cloudflare" &&
          this.data.audioProxy === 1 &&
          urlOrError.startsWith("https://")
        ) {
          const audioPath = urlOrError.replace(
            "https://vtrans.s3-private.mds.yandex.net/tts/prod/",
            ""
          );
          const proxiedAudioUrl = `https://${workerHost}/video-translation/audio-proxy/${audioPath}`;
          console.log(`[VOT] Audio proxied via ${proxiedAudioUrl}`);
          this.audio.src = proxiedAudioUrl;
        }

        this.volumeOnStart = this.getVideoVolume();
        if (typeof this.data.defaultVolume === "number") {
          this.audio.volume = this.data.defaultVolume / 100;
        }
        if (
          typeof this.data.autoSetVolumeYandexStyle === "number" &&
          this.data.autoSetVolumeYandexStyle
        ) {
          this.setVideoVolume(autoVolume);
        }

        switch (this.site.host) {
          case "twitter":
            document
              .querySelector('div[data-testid="app-bar-back"][role="button"]')
              .addEventListener("click", this.stopTranslationBound);
            break;
          case "invidious":
          case "piped":
            break;
        }

        if (!this.video.src && !this.video.currentSrc) {
          this.stopTranslation();
          return;
        }

        const siteHostnames = [
          "twitch",
          "vimeo",
          "facebook",
          "rutube",
          "twitter",
          "bilibili",
          "mail_ru",
        ];
        for (let i = 0; i < siteHostnames.length; i++) {
          if (this.site.host === siteHostnames[i]) {
            const mutationObserver = new MutationObserver(
              (mutations) => {
                mutations.forEach((mutation) => {
                  if (
                    mutation.type === "attributes" &&
                    mutation.attributeName === "src" &&
                    mutation.target === this.video &&
                    mutation.target.src !== ""
                  ) {
                    this.stopTranslation();
                    this.firstPlay = true;
                  }
                });
              }
            );
            mutationObserver.observe(this.container, {
              attributes: true,
              childList: false,
              subtree: true,
              attributeOldValue: true,
            });
            break;
          }
        }

        if (this.video && !this.video.paused) this.lipSync("play");
        videoLipSyncEvents.forEach((e) => this.video.addEventListener(e, this.handleVideoEventBound));
        this.transformBtn("success", localizationProvider.get("disableTranslate"));

        this.votVideoVolumeSlider.container.hidden = this.data.showVideoSlider !== 1 || this.votButton.container.dataset.status !== "success";
        this.votVideoTranslationVolumeSlider.container.hidden = this.votButton.container.dataset.status !== "success";

        if (this.data.autoSetVolumeYandexStyle === 1) {
          this.votVideoVolumeSlider.input.value = autoVolume * 100;
          this.votVideoVolumeSlider.label.querySelector("strong").innerHTML = `${autoVolume * 100}%`;
          ui.updateSlider(this.votVideoVolumeSlider.input);
        }

        this.votDownloadButton.hidden = false;
        this.downloadTranslationUrl = urlOrError;
      }
    );
  }

  // Define a function to stop translation and clean up
  stopTranslation() {
    this.stopTraslate();
    this.syncVideoVolumeSlider();
  }

  async handleSrcChanged() {
    debug.log("[VideoHandler] src changed", this);
    this.stopTranslation();

    this.videoData = await this.getVideoData();

    this.firstPlay = true;

    this.votButton.container.hidden = !this.video.src && !this.video.currentSrc;
    !this.video.src && !this.video.currentSrc && (this.votMenu.container.hidden = !this.video.src && !this.video.currentSrc);

    if (!this.site.selector) {
      this.container = this.video.parentElement;
    }

    if (!this.container.contains(this.votButton.container)) {
      this.container.appendChild(this.votButton.container);
      this.container.appendChild(this.votMenu.container);
    }

    await this.updateSubtitles();
    await this.changeSubtitlesLang("disabled");
    this.setSelectMenuValues(this.videoData.detectedLanguage, this.data.responseLanguage ?? "ru");
    this.translateToLang = this.data.responseLanguage ?? "ru";
  }

  release() {
    debug.log("[VideoHandler] release");
    this.stopTranslation();
    this.releaseExtraEvents();
    this.subtitlesWidget.release();
    this.srcObserver.disconnect();
    this.votButton.container.remove();
    this.votMenu.container.remove();
  }
}

function getSite() {
  return sites.find((e) => {
    const isMathes = (match) => {
      return (match instanceof RegExp && match.test(window.location.hostname))
        || (typeof match === "string" && window.location.hostname.includes(match))
        || (typeof match === "function" && match(window.location));
    };
    if (isMathes(e.match) || (e.match instanceof Array && e.match.some((e) => isMathes(e)))) {
      return e.host && e.url;
    }
    return false;
  });
}

const videoObserver = new VideoObserver();
const videosWrappers = new WeakMap();

async function main() {
  debug.log("Loading extension...");

  await localizationProvider.update();

  debug.log(`Selected menu language: ${localizationProvider.lang}`);

  if (
    BUILD_MODE !== "cloudflare" &&
    GM_info?.scriptHandler &&
    cfOnlyExtensions.includes(GM_info.scriptHandler)
  ) {
    console.error(
      `[VOT] ${localizationProvider
        .getDefault("unSupportedExtensionError")
        .format(GM_info.scriptHandler)}`
    );
    return alert(
      `[VOT] ${localizationProvider
        .get("unSupportedExtensionError")
        .format(GM_info.scriptHandler)}`
    );
  }

  debug.log("Extension compatibility passed...");

  try {
    if (!await initDB()) {
      console.error("[VOT] Failed to initialize database");
      return;
    }
  } catch (err) {
    console.error("[VOT] Failed to initialize database", err);
    return;
  }

  debug.log("database initialized");

  videoObserver.onVideoAdded.addListener((video) => {
    const site = getSite();
    if (!site) return;
    let container;
    if (site.shadowRoot) {
      container = site.selector ? Object.values(document.querySelectorAll(site.selector)).find(e => e.shadowRoot.contains(video)) : video.parentElement;
      container = (container && container.shadowRoot) ? container.parentElement : container;
    } else {
      container = site.selector ? Object.values(document.querySelectorAll(site.selector)).find(e => e.contains(video)) : video.parentElement;
    }
    if (!container) return;
    if (!videosWrappers.has(video)) {
      videosWrappers.set(video, new VideoHandler(video, container, site));
    }
  });
  videoObserver.onVideoRemoved.addListener((video) => {
    if (videosWrappers.has(video)) {
      videosWrappers.get(video).release();
      videosWrappers.delete(video);
    }
  });
  videoObserver.enable();
}

main().catch((e) => {
  console.error("[VOT]", e);
});
