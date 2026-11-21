/**
 * Gmail に届いたカードの利用通知メールを、家計簿に送る (Google Apps Script)
 *
 * iPhone のメールのオートメーションは、iPhone がメールを受信したときにしか動かない (充電中にまとめて受信される)。
 * これは Google のサーバー上で 5 分ごとに Gmail を見に行くので、iPhone の状態に関係なく記録できる。
 *
 * 使い方 (README の「Gmail から自動で記録する」も参照):
 *   1. https://script.google.com で新しいプロジェクトを作り、このファイルの中身を貼り付ける
 *   2. プロジェクトの設定 → スクリプト プロパティ に KAKEIBO_TOKEN = kb_...(家計簿の 設定 → ショートカット で発行) を追加
 *   3. 上のメニューで関数「setup」を選んで実行 (初回だけ Google の許可画面が出る)
 *
 * トークンはスクリプト プロパティに置き、このファイルには書かない。
 * 同じメールを 2 回送っても、家計簿側で二重には記録しない。
 */

// 家計簿の API (メールの本文を受け取る窓口)
const API_URL = 'https://4pem86hvbi.execute-api.ap-southeast-2.amazonaws.com/shortcut/mail';

// 対象のメール。カードを増やしたら OR でつなぐ (例: '(from:qa.jcb.co.jp OR from:example.co.jp)')
const QUERY = 'from:qa.jcb.co.jp subject:ご利用のお知らせ newer_than:3d';

// 何分ごとに見に行くか (1, 5, 10, 15, 30 のどれか)
const EVERY_MINUTES = 5;

/** 5 分ごとに呼ばれる。前回より新しい利用通知メールを古い順に家計簿へ送る */
function check() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('KAKEIBO_TOKEN');
  if (!token) throw new Error('スクリプト プロパティに KAKEIBO_TOKEN を設定してください');
  const last = Number(props.getProperty('LAST_TIME') || 0);

  // 同じ件名のメールは Gmail で 1 つのスレッドにまとまるので、メール 1 通ずつに分けて日時で判定する
  const messages = GmailApp.search(QUERY, 0, 50)
    .flatMap((thread) => thread.getMessages())
    .filter((m) => m.getDate().getTime() > last)
    .sort((a, b) => a.getDate().getTime() - b.getDate().getTime());

  for (const m of messages) {
    const res = UrlFetchApp.fetch(API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ token: token, text: m.getPlainBody() }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    let message = '';
    try {
      message = JSON.parse(res.getContentText()).message || '';
    } catch (e) {
      message = res.getContentText().slice(0, 200);
    }
    console.log(`${m.getDate().toISOString()} ${m.getSubject()} → ${code} ${message}`);
    // 失敗したらそこで止め、次回 (5 分後) にこのメールから送り直す
    if (code >= 300) throw new Error(`家計簿に送れませんでした (${code}): ${message}`);
    props.setProperty('LAST_TIME', String(m.getDate().getTime()));
  }
}

/** 最初に 1 回だけ実行する。5 分ごとの実行を登録し、これまでに届いたメールは送らない */
function setup() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'check') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('check').timeBased().everyMinutes(EVERY_MINUTES).create();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('LAST_TIME')) props.setProperty('LAST_TIME', String(Date.now()));
  console.log(`${EVERY_MINUTES} 分ごとに Gmail を確認します。これより後に届いた利用通知メールを家計簿に記録します`);
}

/** 試しに、直近 3 日の利用通知メールをすべて送り直す (家計簿に記録済みのものは二重にならない) */
function resendRecent() {
  PropertiesService.getScriptProperties().setProperty('LAST_TIME', '0');
  check();
}
