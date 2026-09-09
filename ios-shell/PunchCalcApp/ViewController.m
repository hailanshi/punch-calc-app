#import "ViewController.h"
#import <WebKit/WebKit.h>

/* =====================================================================
 * 极简 iOS 壳：只负责把本地单文件 HTML 装进 WKWebView 并加载。
 * 所有业务逻辑都在 index.html（打卡工资计算器）内，壳层不做任何业务。
 * 适配 iOS 12+ / arm64，打包后可直接用 TrollStore 巨魔商店安装。
 * ===================================================================*/

@interface ViewController () <WKNavigationDelegate>
@property (nonatomic, strong) WKWebView *webView;
@end

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];

    /* file:// 下允许读取本地文件 / 访问本地 storage */
    if (@available(iOS 9.0, *)) {
        [config.preferences setValue:@YES forKey:@"allowFileAccessFromFileURLs"];
        [config.preferences setValue:@YES forKey:@"allowUniversalAccessFromFileURLs"];
    }

    self.webView = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:config];
    self.webView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.webView.navigationDelegate = self;
    self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    self.webView.scrollView.bounces = NO;
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
}

/* 按可能出现的多种资源路径查找 index.html */
- (NSString *)locateHtml {
    NSBundle *b = [NSBundle mainBundle];
    NSString *candidates[] = {
        [b pathForResource:@"index" ofType:@"html"],                 // 打入 .app 根目录
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
    NSString *htmlPath = [self locateHtml];
    if (!htmlPath) {
        /* 找不到页面：显示简单提示，避免白屏无从排查 */
        UILabel *lb = [[UILabel alloc] initWithFrame:self.view.bounds];
        lb.text = @"未找到 index.html\n请把它放到 .app 包内后重新打包。";
        lb.textAlignment = NSTextAlignmentCenter;
        lb.numberOfLines = 0;
        [self.view addSubview:lb];
        return;
    }
    NSURL *url = [NSURL fileURLWithPath:htmlPath];
    NSURL *readAccess = [NSURL fileURLWithPath:[htmlPath stringByDeletingLastPathComponent] isDirectory:YES];
    [self.webView loadFileURL:url allowingReadAccessToURL:readAccess];
}

/* 允许访问网络接口（QQ 公告、工作日联网更新） */
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
        decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (@available(iOS 10.0, *)) {
        decisionHandler(WKNavigationActionPolicyAllow);
    } else {
        decisionHandler(WKNavigationActionPolicyAllow);
    }
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

@end
