#include <jni.h>
#include <node.h>
#include <atomic>
#include <cstring>
#include <string>
#include <vector>
#include <cstdlib>

static std::atomic<bool> started{false};

extern "C" JNIEXPORT jint JNICALL
Java_com_charliflix_player_BackendRuntime_startNode(JNIEnv* env, jclass,
                                                  jobjectArray arguments,
                                                  jstring cache_directory) {
    // node::Start is process-wide and cannot be restarted after it returns.
    if (started.exchange(true)) return -2;
    const jsize count = env->GetArrayLength(arguments);
    if (count < 2 || count > 16) return -3;
    std::vector<std::string> values;
    size_t total = 0;
    for (jsize i = 0; i < count; ++i) {
        auto value = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        if (!value) return -3;
        const char* utf = env->GetStringUTFChars(value, nullptr);
        if (!utf) return -3;
        values.emplace_back(utf);
        env->ReleaseStringUTFChars(value, utf);
        env->DeleteLocalRef(value);
        total += values.back().size() + 1;
        if (total > 65536) return -3;
    }
    const char* cache = env->GetStringUTFChars(cache_directory, nullptr);
    if (!cache) return -3;
    setenv("TMPDIR", cache, 1);
    env->ReleaseStringUTFChars(cache_directory, cache);

    // libuv expects argv strings in contiguous memory for process-title support.
    std::vector<char> buffer(total);
    std::vector<char*> argv;
    char* current = buffer.data();
    for (const auto& value : values) {
        argv.push_back(current);
        std::memcpy(current, value.c_str(), value.size() + 1);
        current += value.size() + 1;
    }
    argv.push_back(nullptr);
    return node::Start(count, argv.data());
}
