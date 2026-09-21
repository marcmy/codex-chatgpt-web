// Side-effect order is deliberate: patch the worker prototype before browser-helper-main starts
// accepting protocol messages and creates the first ChatGPT browser turn.
import "./rate-limit-runtime-patch";
import "./rate-limit-post-submit-recovery";
import "./multipart-error-recovery";
import "./browser-helper-main";
