/*
 * NAPI 绑定：用 HarmonyOS Asset Store（libasset_ndk.z.so）存取凭据主密钥。
 * Main 只经 Shared 的 CredentialKeyStore 调用；密钥经系统资产库加密，明文不落盘（spec 16）。
 */
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "asset/asset_api.h"

#define ALIAS_MAX_BYTES 256

static napi_value throw_asset_error(napi_env env, int32_t code, const char *operation) {
  char message[160];
  snprintf(message, sizeof(message), "asset %s failed: %d", operation, code);
  napi_throw_error(env, "OHOS_ASSET_ERROR", message);
  return NULL;
}

static char *read_utf8_arg(napi_env env, napi_value value, const char *name) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    char message[96];
    snprintf(message, sizeof(message), "%s must be a string", name);
    napi_throw_type_error(env, "OHOS_ASSET_INVALID_ARGUMENT", message);
    return NULL;
  }
  char *buffer = (char *)calloc(length + 1, sizeof(char));
  if (!buffer) {
    napi_throw_error(env, "OHOS_ASSET_OUT_OF_MEMORY", "asset argument allocation failed");
    return NULL;
  }
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &length) != napi_ok) {
    free(buffer);
    napi_throw_type_error(env, "OHOS_ASSET_INVALID_ARGUMENT", "asset argument decoding failed");
    return NULL;
  }
  return buffer;
}

static Asset_Attr blob_attr(uint32_t tag, const char *data, size_t size) {
  Asset_Attr attr;
  attr.tag = tag;
  attr.value.blob.size = (uint32_t)size;
  attr.value.blob.data = (uint8_t *)data;
  return attr;
}

static Asset_Attr number_attr(uint32_t tag, uint32_t value) {
  Asset_Attr attr;
  attr.tag = tag;
  attr.value.u32 = value;
  return attr;
}

static napi_value get_secret(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *alias = read_utf8_arg(env, argv[0], "alias");
  if (!alias) return NULL;
  size_t alias_length = strlen(alias);
  if (alias_length == 0 || alias_length > ALIAS_MAX_BYTES) {
    free(alias);
    napi_throw_range_error(env, "OHOS_ASSET_INVALID_ARGUMENT", "alias length is out of range");
    return NULL;
  }

  Asset_Attr query[2] = {
      blob_attr(ASSET_TAG_ALIAS, alias, alias_length),
      number_attr(ASSET_TAG_RETURN_TYPE, ASSET_RETURN_ALL),
  };
  Asset_ResultSet results = {0};
  int32_t code = OH_Asset_Query(query, 2, &results);
  if (code == ASSET_NOT_FOUND) {
    free(alias);
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;
  }
  if (code != ASSET_SUCCESS) {
    free(alias);
    return throw_asset_error(env, code, "query");
  }

  napi_value secret_value = NULL;
  if (results.count > 0) {
    Asset_Attr *secret = OH_Asset_ParseAttr(&results.results[0], ASSET_TAG_SECRET);
    if (secret && secret->tag == ASSET_TAG_SECRET && secret->value.blob.size > 0) {
      napi_create_string_utf8(env, (const char *)secret->value.blob.data,
                              secret->value.blob.size, &secret_value);
    }
  }
  OH_Asset_FreeResultSet(&results);
  free(alias);
  if (!secret_value) napi_get_null(env, &secret_value);
  return secret_value;
}

static napi_value set_secret(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *alias = read_utf8_arg(env, argv[0], "alias");
  if (!alias) return NULL;
  char *secret = read_utf8_arg(env, argv[1], "secret");
  if (!secret) {
    free(alias);
    return NULL;
  }
  size_t alias_length = strlen(alias);
  size_t secret_length = strlen(secret);
  if (alias_length == 0 || alias_length > ALIAS_MAX_BYTES || secret_length == 0) {
    free(alias);
    free(secret);
    napi_throw_range_error(env, "OHOS_ASSET_INVALID_ARGUMENT", "alias or secret length is invalid");
    return NULL;
  }

  Asset_Attr add_attributes[3] = {
      blob_attr(ASSET_TAG_ALIAS, alias, alias_length),
      blob_attr(ASSET_TAG_SECRET, secret, secret_length),
      number_attr(ASSET_TAG_ACCESSIBILITY, ASSET_ACCESSIBILITY_DEVICE_FIRST_UNLOCKED),
  };
  int32_t code = OH_Asset_Add(add_attributes, 3);
  if (code == ASSET_DUPLICATED) {
    Asset_Attr query[1] = {blob_attr(ASSET_TAG_ALIAS, alias, alias_length)};
    Asset_Attr update[1] = {blob_attr(ASSET_TAG_SECRET, secret, secret_length)};
    code = OH_Asset_Update(query, 1, update, 1);
  }
  free(alias);
  free(secret);
  if (code != ASSET_SUCCESS) return throw_asset_error(env, code, "add");

  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

static napi_value remove_secret(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *alias = read_utf8_arg(env, argv[0], "alias");
  if (!alias) return NULL;
  size_t alias_length = strlen(alias);
  Asset_Attr query[1] = {blob_attr(ASSET_TAG_ALIAS, alias, alias_length)};
  int32_t code = OH_Asset_Remove(query, 1);
  free(alias);
  if (code != ASSET_SUCCESS && code != ASSET_NOT_FOUND) {
    return throw_asset_error(env, code, "remove");
  }
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"get", NULL, get_secret, NULL, NULL, NULL, napi_default, NULL},
      {"set", NULL, set_secret, NULL, NULL, NULL, napi_default, NULL},
      {"remove", NULL, remove_secret, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
