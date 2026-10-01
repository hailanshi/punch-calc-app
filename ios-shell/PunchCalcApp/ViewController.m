#import "ViewController.h"
#import <WebKit/WebKit.h>
#import <Foundation/Foundation.h>
#import <signal.h>
#import <stdlib.h>

/* =====================================================================
 * 极简 iOS 壳：只负责把本地单文件 HTML 装进 WKWebView 并加载。
 * 本版加固：
 *  1) 移除对 WKPreferences 的私有 KVC 写入（新版 iOS 可能抛异常导致启动闪退）
 *  2) 启动与加载全用 @try/@catch 保护
 *  3) 崩溃时把原因写入 App Documents/crash.log（可在“文件”App 里看到）
 *  4) v2.1 起新增 hrFetch 通道：带 Cookie 会话的 POST 取数，
 *     用于读取公司 EHR（登录 / 考勤 / 工资条），规避 WKWebView 跨域限制。
 *  5) v2.2 起新增 WPS 考勤月报「签收」窗口：自定义 scheme voopoo-wps://sign 触发，
 *     弹出覆盖全屏的第二个 WKWebView 打开 WPS 快查页，自动填好
 *     年份 / 月份 / 工号 / 姓名，用户在上面手写签名后点「确认签收」。
 *     之所以必须用真网页：签收请求是页面 JS 里 AES 加密后发出的，
 *     密钥在前端，原生桥没法复现，只能让真页面自己去发。
 * ===================================================================*/

@interface ViewController () <WKNavigationDelegate, WKScriptMessageHandler, NSURLSessionDelegate>
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSNumber *> *hrStarted;

/* WPS 签收窗口 */
@property (nonatomic, strong) UIView *wpsOverlay;
@property (nonatomic, strong) WKWebView *wpsWebView;
@property (nonatomic, strong) NSString *wpsYear;
@property (nonatomic, strong) NSString *wpsMonth;
@property (nonatomic, strong) NSString *wpsEmpId;
@property (nonatomic, strong) NSString *wpsName;
@property (nonatomic, assign) BOOL wpsPrefilled;
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
         * 网络请求（公告/联网更新）由 JS 通过 nativeFetch 通道交给原生做，规避跨域限制。
         * hrFetch 是同一思路的加强版：支持 POST 表单 + 共享 Cookie 会话，用于登录公司 EHR。 */
        [config.userContentController addScriptMessageHandler:self name:@"nativeFetch"];
        [config.userContentController addScriptMessageHandler:self name:@"hrFetch"];
        [config.userContentController addScriptMessageHandler:self name:@"wpsSign"];
        self.hrStarted = [NSMutableDictionary dictionary];

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
    if (webView == self.wpsWebView) {
        _writeLogLine(@"wps webview 加载完成，准备自动填表");
        /* SPA 需要一点时间渲染出表单，隔一会儿再填 */
        __weak typeof(self) weak = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [weak wpsTryPrefill];
        });
        return;
    }
    _writeLogLine(@"webview load finished OK");
}

- (void)dealloc {
    [self wpsTearDown];
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
    if ([message.name isEqualToString:@"wpsSign"]) {
        [self wpsOpenSign:(message.body ?: @{})];
        return;
    }
    if ([message.name isEqualToString:@"hrFetch"]) {
        [self hrHandleMessage:message.body];
        return;
    }
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

#pragma mark - hrFetch：带 Cookie 会话的 POST 取数（读取公司 EHR）

/* body 形如 {id, url, method, body, headers, timeout}
 * 回调用 window.__hrFetchResult(JSON) 回传，data 为 base64 原始字节，
 * 避开把大段 JSON 拼进 JS 字面量时的转义 / 控制字符问题。 */
- (void)hrHandleMessage:(id)rawBody {
    NSDictionary *body = [rawBody isKindOfClass:[NSDictionary class]] ? rawBody : @{};
    NSString *cid  = [body[@"id"] isKindOfClass:[NSString class]] ? body[@"id"] : @"";
    NSString *urls = [body[@"url"] isKindOfClass:[NSString class]] ? body[@"url"] : @"";
    if (urls.length == 0) {
        [self _hrEval:@"" status:0 ok:NO data:[NSData data]];
        return;
    }
    /* 同一个 id 只跑一次：原生回调没有超时保护，避免重复请求把会话打乱 */
    if (cid.length && self.hrStarted[cid]) return;
    if (cid.length) self.hrStarted[cid] = @1;

    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urls]];
    double to = [body[@"timeout"] doubleValue];
    req.timeoutInterval = (to > 0 ? to / 1000.0 : 25.0);
    NSString *method = [body[@"method"] isKindOfClass:[NSString class]] ? [body[@"method"] uppercaseString] : @"POST";
    req.HTTPMethod = method.length ? method : @"POST";

    id bd = body[@"body"];
    if ([bd isKindOfClass:[NSString class]] && [bd length] > 0) {
        [req setHTTPBody:[(NSString *)bd dataUsingEncoding:NSUTF8StringEncoding]];
        [req setValue:@"application/x-www-form-urlencoded; charset=UTF-8" forHTTPHeaderField:@"Content-Type"];
    }
    NSDictionary *hdrs = [body[@"headers"] isKindOfClass:[NSDictionary class]] ? body[@"headers"] : nil;
    if (hdrs) {
        for (NSString *k in hdrs) {
            id v = hdrs[k];
            if ([v isKindOfClass:[NSString class]]) [req setValue:v forHTTPHeaderField:k];
        }
    }
    if (!hdrs[@"Accept"]) [req setValue:@"*/*" forHTTPHeaderField:@"Accept"];

    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
    cfg.HTTPShouldSetCookies = YES;                 /* 自动带上已保存的会话 Cookie */
    cfg.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyAlways;
    cfg.HTTPCookieStorage = [NSHTTPCookieStorage sharedHTTPCookieStorage];
    cfg.timeoutIntervalForRequest = req.timeoutInterval + 5;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg delegate:self delegateQueue:nil];

    __weak typeof(self) weak = self;
    [[session dataTaskWithRequest:req
                completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
        if (err) {
            _writeLogLine([NSString stringWithFormat:@"hrFetch error url=%@ err=%@", urls, err.localizedDescription ?: @""]);
        }
        NSInteger status = 0;
        if ([resp isKindOfClass:[NSHTTPURLResponse class]]) status = [(NSHTTPURLResponse *)resp statusCode];
        BOOL ok = (err == nil && status >= 200 && status < 300);
        [weak _hrEval:cid status:status ok:ok data:(data ?: [NSData data])];
    }] resume];
}

/* 服务器返回 GBK 时，NSUTF8 会解不出来 —— 依次尝试 UTF-8 / GB18030 */
- (NSString *)hrTextFromData:(NSData *)data {
    if (!data.length) return @"";
    id j = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (j) return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *s = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (s) return s;
    NSStringEncoding gb = CFStringConvertEncodingToNSStringEncoding(kCFStringEncodingGB_18030_2000);
    s = [[NSString alloc] initWithData:data encoding:gb];
    if (s) return s;
    _writeLogLine([NSString stringWithFormat:@"hrFetch 文本解码失败 len=%lu", (unsigned long)data.length]);
    return @"";
}

- (void)_hrEval:(NSString *)cid status:(NSInteger)status ok:(BOOL)ok data:(NSData *)data {
    NSString *text = [self hrTextFromData:data];
    NSDictionary *out = @{
        @"id":     (cid ?: @""),
        @"status": @(status),
        @"ok":     @(ok),
        @"text":   (text ?: @""),
        @"b64":    ([data base64EncodedStringWithOptions:0] ?: @"")
    };
    NSData *jd = [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL];
    NSString *json = jd ? [[NSString alloc] initWithData:jd encoding:NSUTF8StringEncoding] : @"{\"id\":\"\",\"ok\":false,\"text\":\"\"}";
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.webView) return;
        /* hrStarted 在这里释放，JS 侧超时后复用同一 id 不会永久卡死 */
        if (cid.length) [self.hrStarted removeObjectForKey:cid];
        NSString *js = [NSString stringWithFormat:@"window.__hrFetchResult && window.__hrFetchResult(%@);", json];
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

#pragma mark - WPS 考勤月报签收（覆盖全屏的第二个 WKWebView）

/* body: {year, month, empId, name}
 * 打开 WPS 快查页并自动填好四个查询条件，剩下的交给用户手写签名 + 点确认签收。
 * 签名与签收都由页面自己完成（请求是页面 JS 加密发的），原生不插手。 */
- (void)wpsOpenSign:(NSDictionary *)body {
    self.wpsYear  = [body[@"year"]  isKindOfClass:[NSString class]] ? body[@"year"]  : @"";
    self.wpsMonth = [body[@"month"] isKindOfClass:[NSString class]] ? body[@"month"] : @"";
    self.wpsEmpId = [body[@"empId"] isKindOfClass:[NSString class]] ? body[@"empId"] : @"";
    self.wpsName  = [body[@"name"]  isKindOfClass:[NSString class]] ? body[@"name"]  : @"";
    self.wpsPrefilled = NO;
    /* overlay 每一次都重建，保证是全新的页面与令牌 */
    [self wpsTearDown];
    [self wpsPresent];
}

- (void)wpsPresent {
    @try {
        UIWindow *win = self.view.window;
        if (!win) return;
        self.wpsOverlay = [[UIView alloc] initWithFrame:win.bounds];
        self.wpsOverlay.backgroundColor = [UIColor whiteColor];
        self.wpsOverlay.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;

        /* 顶栏：标题 + 关闭 */
        UIView *bar = [[UIView alloc] initWithFrame:CGRectMake(0, 0, win.bounds.size.width, 88)];
        bar.backgroundColor = [UIColor colorWithRed:0.98 green:0.95 blue:0.96 alpha:1.0];
        bar.autoresizingMask = UIViewAutoresizingFlexibleWidth;

        UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(64, 48, win.bounds.size.width - 128, 26)];
        title.text = @"考勤月报签收";
        title.textAlignment = NSTextAlignmentCenter;
        title.font = [UIFont boldSystemFontOfSize:17];
        title.textColor = [UIColor colorWithRed:0.24 green:0.20 blue:0.22 alpha:1.0];
        [bar addSubview:title];

        UIButton *close = [UIButton buttonWithType:UIButtonTypeSystem];
        close.frame = CGRectMake(8, 44, 60, 34);
        [close setTitle:@"关闭" forState:UIControlStateNormal];
        close.titleLabel.font = [UIFont systemFontOfSize:16];
        [close addTarget:self action:@selector(wpsCloseTapped) forControlEvents:UIControlEventTouchUpInside];
        [bar addSubview:close];
        [self.wpsOverlay addSubview:bar];

        WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
        [cfg.userContentController addScriptMessageHandler:self name:@"wpsSign"];
        self.wpsWebView = [[WKWebView alloc] initWithFrame:CGRectMake(0, 88, win.bounds.size.width,
                                                                     win.bounds.size.height - 88)
                                            configuration:cfg];
        self.wpsWebView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        self.wpsWebView.navigationDelegate = self;
        self.wpsWebView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
        [self.wpsOverlay addSubview:self.wpsWebView];

        [win addSubview:self.wpsOverlay];
        [win bringSubviewToFront:self.wpsOverlay];

        NSURL *u = [NSURL URLWithString:@"https://web.wps.cn/etapps/query/q/5Jeta36W"];
        [self.wpsWebView loadRequest:[NSURLRequest requestWithURL:u]];
        _writeLogLine([NSString stringWithFormat:@"wps sign 打开: %@年%@月 %@ %@",
                       self.wpsYear, self.wpsMonth, self.wpsEmpId, self.wpsName]);
    } @catch (NSException *e) {
        _writeLogLine([NSString stringWithFormat:@"wpsPresent exception: %@ %@", e.name, e.reason]);
    }
}

- (void)wpsCloseTapped {
    [self wpsTearDown];
    /* 关掉后让网页刷新一下，签收状态能立刻反映出来 */
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView evaluateJavaScript:@"window.wpsAfterSign && window.wpsAfterSign();" completionHandler:nil];
    });
}

- (void)wpsTearDown {
    @try {
        if (self.wpsWebView) {
            [self.wpsWebView stopLoading];
            [self.wpsWebView.configuration.userContentController removeScriptMessageHandlerForName:@"wpsSign"];
            [self.wpsWebView removeFromSuperview];
            self.wpsWebView = nil;
        }
        if (self.wpsOverlay) { [self.wpsOverlay removeFromSuperview]; self.wpsOverlay = nil; }
    } @catch (NSException *e) {}
}

/* 页面上有 4 个 input：年份 / 月份 / 工号 / 姓名。
 * 依次写入并派发 input+change 事件，让 React 收到值。 */
- (void)wpsTryPrefill {
    if (self.wpsPrefilled) return;
    if (!self.wpsYear.length || !self.wpsMonth.length || !self.wpsEmpId.length || !self.wpsName.length) return;
    NSString *js = [NSString stringWithFormat:
        @"(function(){"
         "var ins=document.querySelectorAll('input[type=text]');"
         "if(ins.length<4) return 'wait';"
         "var v=[%@,%@,%@,%@];"
         "for(var i=0;i<4;i++){"
           "var el=ins[i]; if(!el) continue;"
           "var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
           "setter.call(el,v[i]);"
           "el.dispatchEvent(new Event('input',{bubbles:true}));"
           "el.dispatchEvent(new Event('change',{bubbles:true}));"
         "}"
         "return 'ok';"
        "})()",
        [self _jsq:self.wpsYear], [self _jsq:self.wpsMonth],
        [self _jsq:self.wpsEmpId], [self _jsq:self.wpsName]];
    __weak typeof(self) weak = self;
    [self.wpsWebView evaluateJavaScript:js completionHandler:^(id res, NSError *err) {
        if ([res isKindOfClass:[NSString class]] && [res isEqualToString:@"ok"]) {
            weak.wpsPrefilled = YES;
            _writeLogLine(@"wps 已自动填好 年份/月份/工号/姓名");
            /* 填好后自动点一次「查询」，让用户直接看到记录与签收按钮 */
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.6 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                [weak wpsTapQuery];
            });
        } else if (err) {
            _writeLogLine([NSString stringWithFormat:@"wps prefill err: %@", err.localizedDescription ?: @""]);
        }
    }];
}

- (void)wpsTapQuery {
    /* 按钮文字就是「查询」，按文本精确定位后再点 */
    NSString *js =
        @"(function(){"
         "var bs=document.querySelectorAll('button');"
         "for(var i=0;i<bs.length;i++){"
           "var t=(bs[i].innerText||'').trim();"
           "if(t==='查询'){ bs[i].click(); return 'clicked'; }"
         "}"
         "return 'notfound';"
        "})()";
    [self.wpsWebView evaluateJavaScript:js completionHandler:^(id res, NSError *err) {
        _writeLogLine([NSString stringWithFormat:@"wps 自动查询: %@", res ?: @"(nil)"]);
    }];
}

#pragma mark - NSURLSessionDelegate（自签/内部证书不直接失败）

- (void)URLSession:(NSURLSession *)session
        didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
        completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler {
    SecTrustRef trust = challenge.protectionSpace.serverTrust;
    if (trust) {
        completionHandler(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]);
    } else {
        completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    }
}

@end
