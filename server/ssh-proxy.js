/**
 * SSH Proxy Server
 * 
 * Este servidor atua como um proxy entre conexões WebSocket do navegador
 * e servidores SSH remotos. Permite que aplicações web se conectem
 * a servidores SSH sem necessidade de cliente SSH nativo.
 */

const WebSocket = require('ws');
const { Client } = require('ssh2');
const dotenv = require('dotenv');
const http = require('http');
const express = require('express');
const cors = require('cors');

// Carregar variáveis de ambiente
dotenv.config();

// Configuração
const PORT = process.env.PORT || 10000;
const MAX_CONNECTIONS = process.env.MAX_SSH_CONNECTIONS || 10;
const IDLE_TIMEOUT = process.env.SSH_IDLE_TIMEOUT || 300000; // 5 minutos

// Inicializar Express para rota de health check
const app = express();
app.use(cors());

// Rota de health check (importante para o Render detectar que o serviço está ativo)
app.get('/', (req, res) => {
  res.status(200).send({
    status: 'ok',
    message: 'SSH Proxy Server is running',
    connections: Object.keys(activeConnections).length,
    maxConnections: MAX_CONNECTIONS
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Criar servidor HTTP
const server = http.createServer(app);

// Rastrear conexões ativas
const activeConnections = new Map();
let connectionCounter = 0;

// Setup WebSocket Server
const wss = new WebSocket.Server({ server });

console.log(`Iniciando servidor SSH Proxy na porta ${PORT}`);

wss.on('connection', (ws) => {
  // Gerar ID de conexão único
  const connectionId = `conn_${++connectionCounter}`;
  console.log(`Nova conexão WebSocket: ${connectionId}`);
  
  // Dados da conexão
  let sshClient = null;
  let sshStream = null;
  let connectionDetails = null;
  let idleTimeout = null;
  let isConnected = false;
  
  // Registrar conexão ativa
  activeConnections.set(connectionId, {
    connectionId,
    createdAt: new Date(),
    ws,
    isConnected: false,
    host: null,
    username: null
  });

  // Verificar limite de conexões
  if (activeConnections.size > MAX_CONNECTIONS) {
    console.warn(`Limite de conexões atingido (${MAX_CONNECTIONS}). Rejeitando conexão ${connectionId}`);
    sendError(ws, `Servidor atingiu o limite de ${MAX_CONNECTIONS} conexões simultâneas. Tente novamente mais tarde.`);
    ws.close();
    activeConnections.delete(connectionId);
    return;
  }
  
  // Função para resetar timeout de inatividade
  const resetIdleTimeout = () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    
    idleTimeout = setTimeout(() => {
      console.log(`Conexão ${connectionId} atingiu timeout por inatividade`);
      sendMessage(ws, 'disconnect', 'Desconectado por inatividade');
      cleanupConnection();
    }, IDLE_TIMEOUT);
  };
  
  // Processar mensagens do cliente
  ws.on('message', (message) => {
    try {
      resetIdleTimeout();
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'connect':
          // Conectar ao servidor SSH
          handleSshConnection(data);
          break;
          
        case 'data':
          // Enviar dados para o servidor SSH
          if (sshStream && data.content) {
            sshStream.write(data.content);
          }
          break;
          
        case 'resize':
          // Redimensionar terminal
          if (sshStream && data.rows && data.cols) {
            sshStream.setWindow(data.rows, data.cols);
          }
          break;
          
        case 'disconnect':
          // Desconectar voluntariamente
          cleanupConnection();
          break;
          
        case 'ping':
          // Responder ping para manter conexão ativa
          sendMessage(ws, 'pong');
          break;
          
        default:
          console.warn(`Tipo de mensagem desconhecido: ${data.type}`);
      }
    } catch (error) {
      console.error(`Erro ao processar mensagem: ${error.message}`);
      sendError(ws, `Erro ao processar comando: ${error.message}`);
    }
  });
  
  // Detectar fechamento da conexão WebSocket
  ws.on('close', () => {
    console.log(`Conexão WebSocket fechada: ${connectionId}`);
    cleanupConnection();
  });
  
  // Detectar erros na conexão WebSocket
  ws.on('error', (error) => {
    console.error(`Erro na conexão WebSocket ${connectionId}: ${error.message}`);
    cleanupConnection();
  });
  
  // Conectar ao servidor SSH
  const handleSshConnection = (data) => {
    if (!data.host || !data.username) {
      return sendError(ws, 'Host e nome de usuário são obrigatórios');
    }
    
    connectionDetails = {
      host: data.host,
      port: data.port || 22,
      username: data.username,
      password: data.password
    };

    console.log(`Tentando conexão SSH para ${connectionDetails.username}@${connectionDetails.host}:${connectionDetails.port}`);
    
    // Atualizar dados da conexão
    const connInfo = activeConnections.get(connectionId);
    if (connInfo) {
      connInfo.host = connectionDetails.host;
      connInfo.username = connectionDetails.username;
    }
    
    // Inicializar cliente SSH
    sshClient = new Client();
    
    // Conectar ao servidor SSH
    sshClient.on('ready', () => {
      console.log(`Conexão SSH estabelecida: ${connectionId} (${connectionDetails.username}@${connectionDetails.host})`);
      
      // Abrir shell interativo
      sshClient.shell({ term: 'xterm-color' }, (err, stream) => {
        if (err) {
          return sendError(ws, `Erro ao abrir shell: ${err.message}`);
        }
        
        sshStream = stream;
        isConnected = true;
        
        // Atualizar status da conexão
        const connInfo = activeConnections.get(connectionId);
        if (connInfo) {
          connInfo.isConnected = true;
        }
        
        // Notificar cliente que a conexão foi estabelecida
        sendMessage(ws, 'connected');
        
        // Encaminhar dados do SSH para o cliente WebSocket
        stream.on('data', (data) => {
          sendMessage(ws, 'data', data.toString('utf-8'));
        });
        
        // Encaminhar stream fechado para o cliente
        stream.on('close', () => {
          console.log(`Stream SSH fechado: ${connectionId}`);
          sendMessage(ws, 'disconnect', 'Conexão SSH fechada pelo servidor');
          cleanupConnection();
        });
        
        // Encaminhar erros do stream para o cliente
        stream.on('error', (err) => {
          console.error(`Erro no stream SSH ${connectionId}: ${err.message}`);
          sendError(ws, `Erro na sessão SSH: ${err.message}`);
        });
      });
    });
    
    // Tratar erros de conexão SSH
    sshClient.on('error', (err) => {
      console.error(`Erro na conexão SSH ${connectionId}: ${err.message}`);
      sendError(ws, `Falha na conexão SSH: ${err.message}`);
      cleanupConnection();
    });
    
    // Tratar fechamento de conexão SSH
    sshClient.on('end', () => {
      console.log(`Conexão SSH encerrada: ${connectionId}`);
      sendMessage(ws, 'disconnect', 'Conexão SSH encerrada');
      cleanupConnection();
    });
    
    // Tentar conectar com as credenciais fornecidas
    try {
      sshClient.connect(connectionDetails);
    } catch (error) {
      console.error(`Erro ao iniciar conexão SSH ${connectionId}: ${error.message}`);
      sendError(ws, `Não foi possível iniciar conexão SSH: ${error.message}`);
      cleanupConnection();
    }
  };
  
  // Limpar recursos da conexão
  const cleanupConnection = () => {
    // Limpar timeout
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
    
    // Fechar stream SSH
    if (sshStream) {
      try {
        sshStream.end();
        sshStream = null;
      } catch (e) {
        // Ignorar erros ao fechar stream
      }
    }
    
    // Fechar cliente SSH
    if (sshClient) {
      try {
        sshClient.end();
        sshClient = null;
      } catch (e) {
        // Ignorar erros ao fechar cliente
      }
    }
    
    // Fechar WebSocket
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch (e) {
      // Ignorar erros ao fechar WebSocket
    }
    
    // Remover da lista de conexões ativas
    activeConnections.delete(connectionId);
    
    isConnected = false;
    connectionDetails = null;
  };
  
  // Iniciar timeout de inatividade
  resetIdleTimeout();
});

// Funções auxiliares para enviar mensagens pelo WebSocket
function sendMessage(ws, type, content = null) {
  if (ws.readyState === WebSocket.OPEN) {
    const message = { type };
    if (content !== null) {
      message.content = content;
    }
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, errorMessage) {
  sendMessage(ws, 'error', { message: errorMessage });
}

// Iniciar o servidor na porta especificada
server.listen(PORT, () => {
  console.log(`SSH Proxy Server está rodando na porta ${PORT}`);
});

// Tratamento de sinais para encerramento gracioso
process.on('SIGTERM', () => {
  console.log('Recebido sinal SIGTERM. Encerrando servidor...');
  shutdown();
});

process.on('SIGINT', () => {
  console.log('Recebido sinal SIGINT. Encerrando servidor...');
  shutdown();
});

// Função de encerramento gracioso
function shutdown() {
  // Fechar todas as conexões ativas
  for (const [connectionId, conn] of activeConnections.entries()) {
    try {
      console.log(`Fechando conexão ${connectionId} durante desligamento`);
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        sendMessage(conn.ws, 'disconnect', 'Servidor está sendo encerrado');
        conn.ws.close();
      }
    } catch (e) {
      // Ignorar erros ao fechar conexão
    }
  }
  
  // Limpar Map de conexões
  activeConnections.clear();
  
  // Fechar servidor HTTP
  server.close(() => {
    console.log('Servidor HTTP encerrado');
    process.exit(0);
  });
  
  // Forçar encerramento após timeout
  setTimeout(() => {
    console.log('Encerramento forçado após timeout');
    process.exit(1);
  }, 5000);
} 
