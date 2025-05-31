

# serverless-xhttp
* serverless-vless-xhttp，集成哪吒探针，v0或v1可选。
* 哪吒v0的agent端口为{443,8443,2096,2087,2083,2053}其中之一时，自动开启--tls。


* 环境变量
  | 变量名        | 是否必须 | 默认值 | 备注 |
  | ------------ | ------ | ------ | ------ |
  | PORT         | 是 |  3000  |http服务监听端口，也是订阅端口     |
  | UUID         | 否 | 0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b|UUID,使用哪吒v1在不同的平台部署需要修改|
  | NEZHA_SERVER | 否 |        | 哪吒面板域名，v1：nz.aaa.com:8008  v0: nz.aaa.com  |
  | NEZHA_PORT   | 否 |        | 哪吒v1没有此项，哪吒v0端口为{443,8443,2096,2087,2083,2053}其中之一时，开启tls|
  | NEZHA_KEY    | 否 |        | 哪吒v1 或v0 密钥                 |
  | DOMAIN       | 否 |        | 项目域名                         |
  | XPATH        | 否 |  xhttp | 节点路径                         | 
  | AUTO_ACCESS  | 否 |  false | 自动保活，true开启,false关闭       |
  | SUB_PATH     | 否 |  sub   | 节点订阅路径                      |
  | NAME         | 否 |        | 节点名称                         |
