const FormData = require("form-data");
const fetch = require("node-fetch");

const API_KEY = "ZdDZgkeOt4Z_m-UWmqFsE1d6-kcCK3BH0ypYTUIFty4";
const API_URL = "https://t.webiny.com";

/**
 * The main `sendEvent` function.
 * NOTE: don't use this in your app directly. Instead, use the one from `cli.js` or `react.js` files accordingly.
 */
module.exports = ({ event, user, version, properties, extraPayload } = {}) => {
    if (!event) {
        throw new Error(`Cannot send event - missing "event" name.`);
    }

    if (!user) {
        throw new Error(`Cannot send event - missing "user" property.`);
    }

    if (!version) {
        throw new Error(`Cannot send event - missing "version" property.`);
    }

    if (!properties) {
        properties = {};
    }

    if (!extraPayload) {
        extraPayload = {};
    }

    const payload = {
        ...extraPayload,
        event,
        properties: {
            ...properties,
            version
        },
        distinct_id: user,
        api_key: API_KEY,
        timestamp: new Date().toISOString()
    };

    const body = new FormData();
    body.append("data", Buffer.from(JSON.stringify(payload)).toString("base64"));

    // Return a function which will send the prepared body when invoked.
    return () => {
        return fetch(API_URL + "/capture/", {
            body,
            method: "POST"
        }).catch(() => {
            // Ignore errors
        });
    };
};
