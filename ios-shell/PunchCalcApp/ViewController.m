#import "ViewController.h"
#import <WebKit/WebKit.h>
#import <signal.h>
#import <stdlib.h>

/* =====================================================================
 * 极简 iOS 壳：只负责把本地单文件 HTML 装进 WKWebView 并加载。
 * 本版加固：
 *  1) 移除对 WKPreferences 的私有 KVC 写入（新版 iOS 可能抛异常导致启动闪退）
 *  2) 启动与加载全用 @try/@catch 保护
 *  3) 崩溃时把原因写入 App Documents/crash.log（可在“文件”App 里看到）
 * ===================================================================*/

@interface ViewController () <WKNavigationDelegate, WKScriptMessageHandler>
@property (nonatomic, strong) WKWebView *webView;
@end

static void _writeLogLine(NSString *line) {
    @autoreleasepool {
        NSURL *dirs = [[[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory
                                                              inDomains:NSUserDomainMask] firstObject];
        if (!dirs) return;
        NSURL *file = [dirs URLByAppendingPathComponent:@"crash.log"];
        NSString *existing = [NSString stringWithContentsOfURL:file encoding:NSUTF8StringEncoding error:NULL];
        NSString *stamp = [NSDateFormatter localizedStringFromDate:[NSDate date]
                                                          dateStyle:NSDateFormatterShortStyle
                                                          timeStyle:NSDateFormatterMediumStyle];
        NSString *all = [NSString stringWithFormat:@"%@\n==== %@ ====\n%@\n", (existing ?: @""), stamp, line];
        [all writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    }
}

static void _crashHandler(NSException *e) {
    NSString *s = [NSString stringWithFormat:@"NSException: name=%@ reason=%@\nStack:\n%@",
                   e.name, e.reason, [e.callStackSymbols componentsJoinedByString:@"\n"]];
    _writeLogLine(s);
}

static void _signalHandler(int sig) {
    _writeLogLine([NSString stringWithFormat:@"Signal: %d", sig]);
    exit(0);
}

static void _installCrashHandlers(void) {
    NSSetUncaughtExceptionHandler(&_crashHandler);
    signal(SIGABRT, _signalHandler);
    signal(SIGSEGV, _signalHandler);
    signal(SIGILL, _signalHandler);
    signal(SIGBUS, _signalHandler);
}

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    @try {
        _installCrashHandlers();
        _writeLogLine(@"app launched, viewDidLoad reached");

        WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
        /* 注意：这里不再写私有 KVC 键，避免系统版本差异导致异常闪退。
         * 网络请求（公告/联网更新）由 JS 通过 nativeFetch 通道交给原生做，规避跨域限制。 */
        [config.userContentController addScriptMessageHandler:self name:@"nativeFetch"];

        self.webView = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:config];
        self.webView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        self.webView.navigationDelegate = self;
        self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
        self.webView.scrollView.bounces = NO;
        /* iOS 兼容：禁用捏合缩放手势（配合页面 viewport user-scalable=no） */
        self.webView.scrollView.pinchGestureRecognizer.enabled = NO;
        self.webView.opaque = NO;
        self.webView.backgroundColor = [UIColor colorWithRed:1.0 green:0.94 blue:0.94 alpha:1.0];
        self.webView.scrollView.backgroundColor = self.webView.backgroundColor;
        if (@available(iOS 13.0, *)) {
            self.view.backgroundColor = [UIColor systemBackgroundColor];
        } else {
            self.view.backgroundColor = [UIColor whiteColor];
        }
        [self.view addSubview:self.webView];

        [self loadLocalHtml];
    } @catch (NSException *e) {
        _writeLogLine([NSString stringWithFormat:@"viewDidLoad exception: %@ %@", e.name, e.reason]);
    }
}

- (NSString *)locateHtml {
    NSBundle *b = [NSBundle mainBundle];
    NSString *candidates[] = {
        [b pathForResource:@"index" ofType:@"html"],
        [[b resourcePath] stringByAppendingPathComponent:@"www/index.html"],
        [[b resourcePath] stringByAppendingPathComponent:@"Resources/index.html"],
        [b pathForResource:@"index" ofType:@"html" inDirectory:@"Resources"]
    };
    for (int i = 0; i < 4; i++) {
        NSString *p = candidates[i];
        if (p && [[NSFileManager defaultManager] fileExistsAtPath:p]) {
            return p;
        }
    }
    return nil;
}

- (void)loadLocalHtml {
    @try {
        NSString *htmlPath = [self locateHtml];
        if (!htmlPath) {
            _writeLogLine(@"index.html NOT FOUND");
            UILabel *lb = [[UILabel alloc] initWithFrame:self.view.bounds];
            lb.text = @"未找到 index.html\n请把它放到 .app 包内后重新打包。";
            lb.textAlignment = NSTextAlignmentCenter;
            lb.numberOfLines = 0;
            [self.view addSubview:lb];
            return;
        }
        _writeLogLine(@"loading index.html");
        NSURL *url = [NSURL fileURLWithPath:htmlPath];
        NSURL *readAccess = [NSURL fileURLWithPath:[htmlPath stringByDeletingLastPathComponent] isDirectory:YES];
        [self.webView loadFileURL:url allowingReadAccessToURL:readAccess];
    } @catch (NSException *e) {
        _writeLogLine([NSString stringWithFormat:@"loadLocalHtml exception: %@ %@", e.name, e.reason]);
    }
}

/* 允许访问网络接口（QQ 公告、工作日联网更新） */
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
        decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation
      withError:(NSError *)error {
    _writeLogLine([NSString stringWithFormat:@"webview load error: %@", error.localizedDescription ?: @""]);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    _writeLogLine(@"webview load finished OK");
}

- (BOOL)prefersStatusBarHidden {
    return NO;
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    if (@available(iOS 13.0, *)) {
        return UIStatusBarStyleDarkContent;
    }
    return UIStatusBarStyleDefault;
}

/* ---------- 原生取数通道（规避浏览器跨域限制） ---------- */
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.name isEqualToString:@"nativeFetch"]) return;
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : @{};
    NSString *cid = body[@"id"];
    if (!cid) cid = @"";
    NSString *url = body[@"url"];
    if (![url isKindOfClass:[NSString class]] || url.length == 0) {
        [self _evalNativeResult:NO cid:cid text:@""];
        return;
    }
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
    req.timeoutInterval = 14;
    [req setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    __weak typeof(self) weak = self;
    [[[NSURLSession sharedSession] dataTaskWithRequest:req
                                     completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
        BOOL ok = NO;
        NSString *text = @"";
        if (err == nil && resp && data) {
            NSInteger code = [(NSHTTPURLResponse *)resp statusCode];
            if (code >= 200 && code < 300) {
                ok = YES;
                text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
                if (!text) text = @"";
            }
        }
        [weak _evalNativeResult:ok cid:cid text:text];
    }] resume];
}

- (void)_evalNativeResult:(BOOL)ok cid:(NSString *)cid text:(NSString *)text {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.webView) return;
        NSString *js = [NSString stringWithFormat:@"window.__nativeFetchResult && window.__nativeFetchResult(%@, %@, %@);",
                        ok ? @"true" : @"false", [self _jsq:cid], [self _jsq:text]];
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

- (NSString *)_jsq:(NSString *)s {
    if (!s) return @"\"\"";
    NSString *e = [s stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
    e = [e stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    e = [e stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
    e = [e stringByReplacingOccurrencesOfString:@"\r" withString:@"\\r"];
    e = [e stringByReplacingOccurrencesOfString:@"'" withString:@"\\'"];
    return [NSString stringWithFormat:@"\"%@\"", e];
}

@end
