// Form Event Handlers
document.getElementById('testForm').addEventListener('submit', function(e) {
    e.preventDefault();
    const formData = new FormData(this);
    const data = Object.fromEntries(formData);
    console.log('Form Data:', data);
    alert('Form submitted! Check console for data.');
});

document.getElementById('testForm').addEventListener('reset', function() {
    setTimeout(() => {
        alert('Form has been reset!');
    }, 100);
});

// Minimal MCP Server Class
class MCPServer {
    constructor(wizardDemo) {
        this.wizardDemo = wizardDemo;
        this.tools = {};
        this.initializeTools();
    }

    initializeTools() {
        const formFields = this.wizardDemo.getFormFieldInfo();
        const formProperties = {};

        formFields.forEach(field => {
            if (field.name) {
                formProperties[field.name] = {
                    type: 'string',
                    description: field.label
                };
            }
        });

        this.tools['fill_form_data'] = {
            name: 'fill_form_data',
            description: 'Fill form fields with the provided data. You must provide a value for every field in the form.',
            inputSchema: {
                type: 'object',
                properties: {
                    formData: {
                        type: 'object',
                        description: 'Object containing form field names and values to fill',
                        properties: formProperties,
                        required: Object.keys(formProperties) // Make all fields required for the tool
                    }
                },
                required: ['formData']
            }
        };
    }
    
    handleMCPRequest(message) {
        const { method, params, id } = message;
        
        switch (method) {
            case 'tools/list':
                return this.handleToolsList(id);
            case 'tools/call':
                return this.handleToolCall(params, id);
            default:
                return {
                    jsonrpc: '2.0',
                    id: id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${method}`
                    }
                };
        }
    }
    
    handleToolsList(id) {
        return {
            jsonrpc: '2.0',
            id: id,
            result: {
                tools: Object.values(this.tools)
            }
        };
    }
    
    handleToolCall(params, id) {
        const { name, arguments: args } = params;
        
        if (name === 'fill_form_data') {
            try {
                this.wizardDemo.fillFormWithData(args.formData);
                return {
                    jsonrpc: '2.0',
                    id: id,
                    result: {
                        content: [{
                            type: 'text',
                            text: 'Form filled successfully'
                        }]
                    }
                };
            } catch (error) {
                return {
                    jsonrpc: '2.0',
                    id: id,
                    error: {
                        code: -32603,
                        message: `Error filling form: ${error.message}`
                    }
                };
            }
        }
        
        return {
            jsonrpc: '2.0',
            id: id,
            error: {
                code: -32601,
                message: `Tool not found: ${name}`
            }
        };
    }
}

// Wizard Demo Class
class WizardDemo {
    constructor() {
        this.agentUrl = 'ws://localhost:8000/chat';
        this.ws = null;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.mcpServer = new MCPServer(this);
        this.setupWizardButton();
        this.connectToAgent();
    }
    
    connectToAgent() {
        try {
            this.ws = new WebSocket(this.agentUrl);
            
            this.ws.onopen = () => {
                console.log('Connected to agent via WebSocket');
                this.showStatus('Connected to agent');
                setTimeout(() => {
                    document.getElementById('wizardStatus').style.display = 'none';
                }, 2000);
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleAgentResponse(data);
                } catch (error) {
                    console.error('Error parsing agent response:', error);
                    this.showStatus('Error parsing agent response', true);
                }
            };
            
            this.ws.onclose = () => {
                console.log('Disconnected from agent');
                this.showStatus('Disconnected from agent', true);
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.showStatus('Agent connection error', true);
            };
            
        } catch (error) {
            console.error('Failed to connect to agent:', error);
            this.showStatus('Failed to connect to agent', true);
        }
    }
    
    setupWizardButton() {
        const wizardButton = document.getElementById('wizardButton');
        
        wizardButton.addEventListener('click', () => {
            this.sendPromptToAgent('Fill out this form with realistic sample data');
        });
    }
    
    sendPromptToAgent(prompt) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.showStatus('Agent not connected', true);
            return;
        }
        
        const messageId = (++this.messageId).toString();
        
        // Get form field information
        const formFields = this.getFormFieldInfo();
        
        const message = {
            message: prompt,
            messageId: messageId,
            page_url: window.location.href,
            page_title: document.title,
            form_fields: formFields
        };
        
        this.showStatus('Sending prompt to agent...');
        this.ws.send(JSON.stringify(message));
        
        // Store the request for response handling
        this.pendingRequests.set(messageId, {
            timestamp: Date.now(),
            prompt: prompt
        });
    }
    
    getFormFieldInfo() {
        const fields = [];
        
        const textInputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]');
        textInputs.forEach(input => {
            const label = document.querySelector(`label[for="${input.id}"]`);
            fields.push({
                id: input.id,
                name: input.name,
                type: input.type,
                label: label ? label.textContent : input.placeholder || input.id,
                required: input.required
            });
        });
        
        const selects = document.querySelectorAll('select');
        selects.forEach(select => {
            const label = document.querySelector(`label[for="${select.id}"]`);
            const options = Array.from(select.options).map(opt => ({
                value: opt.value,
                text: opt.textContent
            }));
            fields.push({
                id: select.id,
                name: select.name,
                type: 'select',
                label: label ? label.textContent : select.id,
                options: options,
                required: select.required
            });
        });
        
        const radioGroups = {};
        const radios = document.querySelectorAll('input[type="radio"]');
        radios.forEach(radio => {
            if (!radioGroups[radio.name]) {
                radioGroups[radio.name] = {
                    name: radio.name,
                    type: 'radio',
                    options: []
                };
            }
            const label = document.querySelector(`label[for="${radio.id}"]`);
            radioGroups[radio.name].options.push({
                value: radio.value,
                text: label ? label.textContent : radio.value
            });
        });
        Object.values(radioGroups).forEach(group => fields.push(group));
        
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            const label = document.querySelector(`label[for="${checkbox.id}"]`);
            fields.push({
                id: checkbox.id,
                name: checkbox.name,
                type: 'checkbox',
                label: label ? label.textContent : checkbox.id,
                value: checkbox.value,
                required: checkbox.required
            });
        });
        
        const textareas = document.querySelectorAll('textarea');
        textareas.forEach(textarea => {
            const label = document.querySelector(`label[for="${textarea.id}"]`);
            fields.push({
                id: textarea.id,
                name: textarea.name,
                type: 'textarea',
                label: label ? label.textContent : textarea.placeholder || textarea.id,
                required: textarea.required
            });
        });
        
        return fields;
    }
    
    handleAgentResponse(data) {
        // Check if this is an MCP request
        if (data.jsonrpc && data.method) {
            console.log('Received MCP request:', data);
            const mcpResponse = this.mcpServer.handleMCPRequest(data);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                console.log('Sending MCP response:', mcpResponse);
                this.ws.send(JSON.stringify(mcpResponse));
            }
            return;
        }
        
        const messageId = data.messageId;
        
        if (data.error) {
            console.error('Agent error:', data.error);
            this.showStatus('Agent error: ' + data.error, true);
            return;
        }
        
        if (data.result) {
            console.log('Agent response:', data.result);
            this.showStatus('Agent response received');
            
            const request = this.pendingRequests.get(messageId);
            if (request) {
                this.showStatus('Agent processed request');
            }
            
            this.pendingRequests.delete(messageId);
            
            setTimeout(() => {
                document.getElementById('wizardStatus').style.display = 'none';
            }, 3000);
        }
    }
    
    showStatus(message, isError = false) {
        const wizardStatus = document.getElementById('wizardStatus');
        const statusContent = wizardStatus.querySelector('.status-content');
        
        statusContent.textContent = message;
        wizardStatus.style.display = 'block';
        
        if (isError) {
            wizardStatus.style.backgroundColor = '#dc3545';
            statusContent.style.color = 'white';
        } else {
            wizardStatus.style.backgroundColor = '#ffffff';
            statusContent.style.color = '#0f62fe';
        }
        
        wizardStatus.classList.add('pulsing');
        
        // Remove pulsing animation after showing
        setTimeout(() => {
            wizardStatus.classList.remove('pulsing');
        }, 1500);
    }
    
    fillFormWithData(formData) {
        if (formData.name) document.getElementById('name').value = formData.name;
        if (formData.email) document.getElementById('email').value = formData.email;
        if (formData.phone) document.getElementById('phone').value = formData.phone;
        if (formData.message) document.getElementById('message').value = formData.message;
        if (formData.country) document.getElementById('country').value = formData.country;
        
        if (formData.contact_method) {
            const radioButton = document.getElementById(`contact-${formData.contact_method}`);
            if (radioButton) radioButton.checked = true;
        }
        
        if (formData.newsletter !== undefined) {
            document.getElementById('newsletter').checked = formData.newsletter;
        }
        if (formData.terms !== undefined) {
            document.getElementById('terms').checked = formData.terms;
        }
        
        this.highlightFilledFields();
    }
    
    
    highlightFilledFields() {
        const fields = ['name', 'email', 'phone', 'country', 'message'];
        
        fields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.style.backgroundColor = '#e8f5e8';
                field.style.borderColor = '#28a745';
                
                setTimeout(() => {
                    field.style.backgroundColor = '';
                    field.style.borderColor = '';
                }, 3000);
            }
        });
        
        ['newsletter', 'terms'].forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field && field.checked) {
                const parent = field.closest('.checkbox-group');
                if (parent) {
                    parent.style.backgroundColor = '#e8f5e8';
                    parent.style.borderRadius = '4px';
                    parent.style.padding = '5px';
                    
                    setTimeout(() => {
                        parent.style.backgroundColor = '';
                        parent.style.borderRadius = '';
                        parent.style.padding = '';
                    }, 3000);
                }
            }
        });
    }
}

// Initialize the wizard demo when the DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    new WizardDemo();
});
