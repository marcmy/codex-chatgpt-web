// Side-effect order is deliberate: patch the worker prototype before browser-helper-main starts
// accepting protocol messages and creates the first ChatGPT browser turn.
import "./rate-limit-runtime-patch";
import "./browser-helper-main";
